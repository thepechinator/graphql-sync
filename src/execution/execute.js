/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import { GraphQLError, locatedError } from 'graphql/error';
import find from 'graphql/jsutils/find';
import invariant from 'graphql/jsutils/invariant';
import isNullish from 'graphql/jsutils/isNullish';
import { typeFromAST } from 'graphql/utilities/typeFromAST';
import { Kind } from 'graphql/language';
import { getVariableValues, getArgumentValues } from 'graphql/execution/values';
import {
  GraphQLScalarType,
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
  isAbstractType
} from 'graphql/type/definition';
import type {
  GraphQLType,
  GraphQLAbstractType,
  GraphQLFieldDefinition,
  GraphQLResolveInfo,
} from 'graphql/type/definition';
import { GraphQLSchema } from 'graphql/type/schema';
import {
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef
} from 'graphql/type/introspection';
import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective
} from 'graphql/type/directives';
import type {
  Directive,
  Document,
  OperationDefinition,
  SelectionSet,
  Field,
  InlineFragment,
  FragmentDefinition
} from 'graphql/language/ast';


/**
 * Terminology
 *
 * "Definitions" are the generic name for top-level statements in the document.
 * Examples of this include:
 * 1) Operations (such as a query)
 * 2) Fragments
 *
 * "Operations" are a generic name for requests in the document.
 * Examples of this include:
 * 1) query,
 * 2) mutation
 *
 * "Selections" are the statements that can appear legally and at
 * single level of the query. These include:
 * 1) field references e.g "a"
 * 2) fragment "spreads" e.g. "...c"
 * 3) inline fragment "spreads" e.g. "...on Type { a }"
 */

/**
 * Data that must be available at all points during query execution.
 *
 * Namely, schema of the type system that is currently executing,
 * and the fragments defined in the query document
 */
type ExecutionContext = {
  schema: GraphQLSchema;
  fragments: {[key: string]: FragmentDefinition};
  rootValue: any;
  operation: OperationDefinition;
  variableValues: {[key: string]: any};
  errors: Array<GraphQLError>;
}

/**
 * The result of execution. `data` is the result of executing the
 * query, `errors` is null if no errors occurred, and is a
 * non-empty array if an error occurred.
 */
type ExecutionResult = {
  data: ?Object;
  errors?: Array<GraphQLError>;
}

/**
 * Implements the "Evaluating requests" section of the GraphQL specification.
 *
 * If the arguments to this function do not result in a legal execution context,
 * a GraphQLError will be thrown immediately explaining the invalid input.
 */
export function execute(
  schema: GraphQLSchema,
  documentAST: Document,
  rootValue?: any,
  variableValues?: ?{[key: string]: any},
  operationName?: ?string
): ExecutionResult {
  invariant(schema, 'Must provide schema');
  invariant(
    schema instanceof GraphQLSchema,
    'Schema must be an instance of GraphQLSchema. Also ensure that there are ' +
    'not multiple versions of GraphQL installed in your node_modules directory.'
  );

  // If a valid context cannot be created due to incorrect arguments,
  // this will throw an error.
  var context = buildExecutionContext(
    schema,
    documentAST,
    rootValue,
    variableValues,
    operationName
  );

  // Return the data described by
  // The "Response" section of the GraphQL specification.
  //
  // If errors are encountered while executing a GraphQL field, only that
  // field and it's descendents will be omitted, and sibling fields will still
  // be executed. An execution which encounters errors will still result in a
  // return value.
  var data;
  try {
    data = executeOperation(context, context.operation, rootValue);
  } catch (error) {
    // Errors from sub-fields of a NonNull type may propagate to the top level,
    // at which point we still log the error and null the parent field, which
    // in this case is the entire response.
    context.errors.push(error);
    data = null;
  }
  if (!context.errors.length) {
    return { data };
  }
  return { data, errors: context.errors };
}

/**
 * Constructs a ExecutionContext object from the arguments passed to
 * execute, which we will pass throughout the other execution methods.
 *
 * Throws a GraphQLError if a valid execution context cannot be created.
 */
function buildExecutionContext(
  schema: GraphQLSchema,
  documentAST: Document,
  rootValue: any,
  rawVariableValues: ?{[key: string]: any},
  operationName: ?string
): ExecutionContext {
  var errors: Array<GraphQLError> = [];
  var operations: {[name: string]: OperationDefinition} = {};
  var fragments: {[name: string]: FragmentDefinition} = {};
  documentAST.definitions.forEach(statement => {
    switch (statement.kind) {
      case Kind.OPERATION_DEFINITION:
        operations[statement.name ? statement.name.value : ''] = statement;
        break;
      case Kind.FRAGMENT_DEFINITION:
        fragments[statement.name.value] = statement;
        break;
      default: throw new GraphQLError(
        `GraphQL cannot execute a request containing a ${statement.kind}.`,
        statement
      );
    }
  });
  if (!operationName && Object.keys(operations).length !== 1) {
    throw new GraphQLError(
      'Must provide operation name if query contains multiple operations.'
    );
  }
  var opName = operationName || Object.keys(operations)[0];
  var operation = operations[opName];
  if (!operation) {
    throw new GraphQLError(`Unknown operation named "${opName}".`);
  }
  var variableValues = getVariableValues(
    schema,
    operation.variableDefinitions || [],
    rawVariableValues || {}
  );
  var exeContext: ExecutionContext =
    { schema, fragments, rootValue, operation, variableValues, errors };
  return exeContext;
}

/**
 * Implements the "Evaluating operations" section of the spec.
 */
function executeOperation(
  exeContext: ExecutionContext,
  operation: OperationDefinition,
  rootValue: any
): Object {
  var type = getOperationRootType(exeContext.schema, operation);
  var fields = collectFields(exeContext, type, operation.selectionSet, {}, {});
  if (operation.operation === 'mutation') {
    return executeFieldsSerially(exeContext, type, rootValue, fields);
  }
  return executeFields(exeContext, type, rootValue, fields);
}

/**
 * Extracts the root type of the operation from the schema.
 */
function getOperationRootType(
  schema: GraphQLSchema,
  operation: OperationDefinition
): GraphQLObjectType {
  switch (operation.operation) {
    case 'query':
      return schema.getQueryType();
    case 'mutation':
      var mutationType = schema.getMutationType();
      if (!mutationType) {
        throw new GraphQLError(
          'Schema is not configured for mutations',
          [ operation ]
        );
      }
      return mutationType;
    default:
      throw new GraphQLError(
        'Can only execute queries and mutations',
        [ operation ]
      );
  }
}

/**
 * Implements the "Evaluating selection sets" section of the spec
 * for "write" mode.
 */
function executeFieldsSerially(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: any,
  fields: {[key: string]: Array<Field>}
): Object {
  return Object.keys(fields).reduce(
    (results, responseName) => {
      var fieldASTs = fields[responseName];
      var result = resolveField(exeContext, parentType, sourceValue, fieldASTs);
      if (result === undefined) {
        return results;
      }
      results[responseName] = result;
      return results;
    },
    {}
  );
}

/**
 * Implements the "Evaluating selection sets" section of the spec
 * for "read" mode.
 */
function executeFields(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: any,
  fields: {[key: string]: Array<Field>}
): Object {
  var finalResults = Object.keys(fields).reduce(
    (results, responseName) => {
      var fieldASTs = fields[responseName];
      var result = resolveField(exeContext, parentType, sourceValue, fieldASTs);
      if (result === undefined) {
        return results;
      }
      results[responseName] = result;
      return results;
    },
    {}
  );

  return finalResults;
}

/**
 * Given a selectionSet, adds all of the fields in that selection to
 * the passed in map of fields, and returns it at the end.
 *
 * CollectFields requires the "runtime type" of an object. For a field which
 * returns and Interface or Union type, the "runtime type" will be the actual
 * Object type returned by that field.
 */
function collectFields(
  exeContext: ExecutionContext,
  runtimeType: GraphQLObjectType,
  selectionSet: SelectionSet,
  fields: {[key: string]: Array<Field>},
  visitedFragmentNames: {[key: string]: boolean}
): {[key: string]: Array<Field>} {
  for (var i = 0; i < selectionSet.selections.length; i++) {
    var selection = selectionSet.selections[i];
    switch (selection.kind) {
      case Kind.FIELD:
        if (!shouldIncludeNode(exeContext, selection.directives)) {
          continue;
        }
        var name = getFieldEntryKey(selection);
        if (!fields[name]) {
          fields[name] = [];
        }
        fields[name].push(selection);
        break;
      case Kind.INLINE_FRAGMENT:
        if (!shouldIncludeNode(exeContext, selection.directives) ||
            !doesFragmentConditionMatch(exeContext, selection, runtimeType)) {
          continue;
        }
        collectFields(
          exeContext,
          runtimeType,
          selection.selectionSet,
          fields,
          visitedFragmentNames
        );
        break;
      case Kind.FRAGMENT_SPREAD:
        var fragName = selection.name.value;
        if (visitedFragmentNames[fragName] ||
            !shouldIncludeNode(exeContext, selection.directives)) {
          continue;
        }
        visitedFragmentNames[fragName] = true;
        var fragment = exeContext.fragments[fragName];
        if (!fragment ||
            !shouldIncludeNode(exeContext, fragment.directives) ||
            !doesFragmentConditionMatch(exeContext, fragment, runtimeType)) {
          continue;
        }
        collectFields(
          exeContext,
          runtimeType,
          fragment.selectionSet,
          fields,
          visitedFragmentNames
        );
        break;
    }
  }
  return fields;
}

/**
 * Determines if a field should be included based on the @include and @skip
 * directives, where @skip has higher precidence than @include.
 */
function shouldIncludeNode(
  exeContext: ExecutionContext,
  directives: ?Array<Directive>
): boolean {
  var skipAST = directives && find(
    directives,
    directive => directive.name.value === GraphQLSkipDirective.name
  );
  if (skipAST) {
    var { if: skipIf } = getArgumentValues(
      GraphQLSkipDirective.args,
      skipAST.arguments,
      exeContext.variableValues
    );
    return !skipIf;
  }

  var includeAST = directives && find(
    directives,
    directive => directive.name.value === GraphQLIncludeDirective.name
  );
  if (includeAST) {
    var { if: includeIf } = getArgumentValues(
      GraphQLIncludeDirective.args,
      includeAST.arguments,
      exeContext.variableValues
    );
    return Boolean(includeIf);
  }

  return true;
}

/**
 * Determines if a fragment is applicable to the given type.
 */
function doesFragmentConditionMatch(
  exeContext: ExecutionContext,
  fragment: FragmentDefinition | InlineFragment,
  type: GraphQLObjectType
): boolean {
  var conditionalType = typeFromAST(exeContext.schema, fragment.typeCondition);
  if (conditionalType === type) {
    return true;
  }
  if (isAbstractType(conditionalType)) {
    return ((conditionalType: any): GraphQLAbstractType).isPossibleType(type);
  }
  return false;
}

/**
 * Implements the logic to compute the key of a given field’s entry
 */
function getFieldEntryKey(node: Field): string {
  return node.alias ? node.alias.value : node.name.value;
}

/**
 * Resolves the field on the given source object. In particular, this
 * figures out the value that the field returns by calling its resolve function,
 * then calls completeValue to serialize scalars, or execute
 * the sub-selection-set for objects.
 */
function resolveField(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  source: Object,
  fieldASTs: Array<Field>
): any {
  var fieldAST = fieldASTs[0];
  var fieldName = fieldAST.name.value;

  var fieldDef = getFieldDef(exeContext.schema, parentType, fieldName);
  if (!fieldDef) {
    return;
  }

  var returnType = fieldDef.type;
  var resolveFn = fieldDef.resolve || defaultResolveFn;

  // Build a JS object of arguments from the field.arguments AST, using the
  // variables scope to fulfill any variable references.
  // TODO: find a way to memoize, in case this field is within a List type.
  var args = getArgumentValues(
    fieldDef.args,
    fieldAST.arguments,
    exeContext.variableValues
  );

  // The resolve function's optional third argument is a collection of
  // information about the current execution state.
  var info: GraphQLResolveInfo = {
    fieldName,
    fieldASTs,
    returnType,
    parentType,
    schema: exeContext.schema,
    fragments: exeContext.fragments,
    rootValue: exeContext.rootValue,
    operation: exeContext.operation,
    variableValues: exeContext.variableValues,
  };

  // If an error occurs while calling the field `resolve` function, ensure that
  // it is wrapped as a GraphQLError with locations. Log this error and return
  // null if allowed, otherwise throw the error so the parent field can handle
  // it.
  try {
    var result = resolveFn(source, args, info);
  } catch (error) {
    var reportedError = locatedError(error, fieldASTs);
    if (returnType instanceof GraphQLNonNull) {
      throw reportedError;
    }
    exeContext.errors.push(reportedError);
    return null;
  }

  return completeValueCatchingError(
    exeContext,
    returnType,
    fieldASTs,
    info,
    result
  );
}

function completeValueCatchingError(
  exeContext: ExecutionContext,
  returnType: GraphQLType,
  fieldASTs: Array<Field>,
  info: GraphQLResolveInfo,
  result: any
): any {
  // If the field type is non-nullable, then it is resolved without any
  // protection from errors.
  if (returnType instanceof GraphQLNonNull) {
    return completeValue(exeContext, returnType, fieldASTs, info, result);
  }

  // Otherwise, error protection is applied, logging the error and resolving
  // a null value for this field if one is encountered.
  try {
    var completed = completeValue(
      exeContext,
      returnType,
      fieldASTs,
      info,
      result
    );
    return completed;
  } catch (error) {
    exeContext.errors.push(error);
    return null;
  }
}

/**
 * Implements the instructions for completeValue as defined in the
 * "Field entries" section of the spec.
 *
 * If the field type is Non-Null, then this recursively completes the value
 * for the inner type. It throws a field error if that completion returns null,
 * as per the "Nullability" section of the spec.
 *
 * If the field type is a List, then this recursively completes the value
 * for the inner type on each item in the list.
 *
 * If the field type is a Scalar or Enum, ensures the completed value is a legal
 * value of the type by calling the `serialize` method of GraphQL type
 * definition.
 *
 * Otherwise, the field type expects a sub-selection set, and will complete the
 * value by evaluating all sub-selections.
 */
function completeValue(
  exeContext: ExecutionContext,
  returnType: GraphQLType,
  fieldASTs: Array<Field>,
  info: GraphQLResolveInfo,
  result: any
): any {
  // If field type is NonNull, complete for inner type, and throw field error
  // if result is null.
  if (returnType instanceof GraphQLNonNull) {
    var completed = completeValue(
      exeContext,
      returnType.ofType,
      fieldASTs,
      info,
      result
    );
    if (completed === null) {
      throw new GraphQLError(
        `Cannot return null for non-nullable ` +
        `field ${info.parentType}.${info.fieldName}.`,
        fieldASTs
      );
    }
    return completed;
  }

  // If result is null-like, return null.
  if (isNullish(result)) {
    return null;
  }

  // If field type is List, complete each item in the list with the inner type
  if (returnType instanceof GraphQLList) {
    invariant(
      Array.isArray(result),
      'User Error: expected iterable, but did not find one.'
    );

    // This is specified as a simple map.
    var itemType = returnType.ofType;
    var completedResults = result.map(item => {
      var completedItem =
        completeValueCatchingError(exeContext, itemType, fieldASTs, info, item);
      return completedItem;
    });

    return completedResults;
  }

  // If field type is Scalar or Enum, serialize to a valid value, returning
  // null if serialization is not possible.
  if (returnType instanceof GraphQLScalarType ||
      returnType instanceof GraphQLEnumType) {
    invariant(returnType.serialize, 'Missing serialize method on type');
    var serializedResult = returnType.serialize(result);
    return isNullish(serializedResult) ? null : serializedResult;
  }

  // Field type must be Object, Interface or Union and expect sub-selections.
  var runtimeType: ?GraphQLObjectType;

  if (returnType instanceof GraphQLObjectType) {
    runtimeType = returnType;
  } else if (isAbstractType(returnType)) {
    var abstractType: GraphQLAbstractType = (returnType: any);
    runtimeType = abstractType.getObjectType(result, info);
    if (runtimeType && !abstractType.isPossibleType(runtimeType)) {
      throw new GraphQLError(
        `Runtime Object type "${runtimeType}" is not a possible type ` +
        `for "${abstractType}".`,
        fieldASTs
      );
    }
  }

  if (!runtimeType) {
    return null;
  }

  // If there is an isTypeOf predicate function, call it with the
  // current result. If isTypeOf returns false, then raise an error rather
  // than continuing execution.
  if (runtimeType.isTypeOf && !runtimeType.isTypeOf(result, info)) {
    throw new GraphQLError(
      `Expected value of type "${runtimeType}" but got: ${result}.`,
      fieldASTs
    );
  }

  // Collect sub-fields to execute to complete this value.
  var subFieldASTs = {};
  var visitedFragmentNames = {};
  for (var i = 0; i < fieldASTs.length; i++) {
    var selectionSet = fieldASTs[i].selectionSet;
    if (selectionSet) {
      subFieldASTs = collectFields(
        exeContext,
        runtimeType,
        selectionSet,
        subFieldASTs,
        visitedFragmentNames
      );
    }
  }

  return executeFields(exeContext, runtimeType, result, subFieldASTs);
}

/**
 * If a resolve function is not given, then a default resolve behavior is used
 * which takes the property of the source object of the same name as the field
 * and returns it as the result, or if it's a function, returns the result
 * of calling that function.
 */
function defaultResolveFn(source, args, { fieldName }) {
  var property = source[fieldName];
  return typeof property === 'function' ? property.call(source) : property;
}

/**
 * This method looks up the field on the given type defintion.
 * It has special casing for the two introspection fields, __schema
 * and __typename. __typename is special because it can always be
 * queried as a field, even in situations where no other fields
 * are allowed, like on a Union. __schema could get automatically
 * added to the query type, but that would require mutating type
 * definitions, which would cause issues.
 */
function getFieldDef(
  schema: GraphQLSchema,
  parentType: GraphQLObjectType,
  fieldName: string
): ?GraphQLFieldDefinition {
  if (fieldName === SchemaMetaFieldDef.name &&
      schema.getQueryType() === parentType) {
    return SchemaMetaFieldDef;
  } else if (fieldName === TypeMetaFieldDef.name &&
             schema.getQueryType() === parentType) {
    return TypeMetaFieldDef;
  } else if (fieldName === TypeNameMetaFieldDef.name) {
    return TypeNameMetaFieldDef;
  }
  return parentType.getFields()[fieldName];
}