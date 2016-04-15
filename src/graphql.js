/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import { Source } from 'graphql/language/source';
import { parse } from 'graphql/language/parser';
import { validate } from 'graphql/validation/validate';
import { execute } from './execution/execute';
import type { GraphQLError } from 'graphql/error/GraphQLError';
import type { GraphQLSchema } from 'graphql/type/schema';


/**
 * This is the primary entry point function for fulfilling GraphQL operations
 * by parsing, validating, and executing a GraphQL document along side a
 * GraphQL schema.
 *
 * More sophisticated GraphQL servers, such as those which persist queries,
 * may wish to separate the validation and execution phases to a static time
 * tooling step, and a server runtime step.
 */
export function graphql(
  schema: GraphQLSchema,
  requestString: string,
  rootValue?: mixed,
  contextValue?: mixed,
  variableValues?: ?{[key: string]: mixed},
  operationName?: ?string
): GraphQLResult {
  try {
    const source = new Source(requestString || '', 'GraphQL request');
    const documentAST = parse(source);
    const validationErrors = validate(schema, documentAST);
    if (validationErrors.length > 0) {
      return { errors: validationErrors };
    }
    return execute(
      schema,
      documentAST,
      rootValue,
      contextValue,
      variableValues,
      operationName
    );
  } catch (error) {
    return { errors: [ error ] };
  }
}

/**
 * The result of a GraphQL parse, validation and execution.
 *
 * `data` is the result of a successful execution of the query.
 * `errors` is included when any errors occurred as a non-empty array.
 */
type GraphQLResult = {
  data?: ?Object;
  errors?: Array<GraphQLError>;
}