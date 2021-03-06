# GraphQL-sync

This is a promise-free wrapper of [GraphQL.js](https://github.com/graphql/graphql-js) for [ArangoDB](https://www.arangodb.com) that replaces all asynchronous code with synchronous equivalents.

**Note**: Looking for GraphQL 0.12 and later? [GraphQL.js now can be used synchronously](https://github.com/graphql/graphql-js/releases/tag/v0.12.0). Just add `graphql` as a node dependency of your service and use it directly. Note that you'll need to use the `graphqlSync` method instead of the `graphql` method in the examples below.

## Getting Started

An overview of GraphQL in general is available in the
[README](https://github.com/facebook/graphql/blob/master/README.md) for the
[Specification for GraphQL](https://github.com/facebook/graphql).

### ArangoDB example

You can use GraphQL-sync in [ArangoDB](https://www.arangdb.com) to build your own GraphQL endpoints directly inside the database using the [Foxx](https://www.arangodb.com/foxx) framework.

An example Foxx service using GraphQL-sync is available as [demo-graphql](https://github.com/arangodb-foxx/demo-graphql) in the Foxx service store. You can find out more about using GraphQL with Foxx in the ArangoDB blog article [*Using GraphQL with NoSQL database ArangoDB*](https://www.arangodb.com/2016/02/using-graphql-nosql-database-arangodb/).

Starting with ArangoDB 3.2 you can use the [Foxx GraphQL integration](https://docs.arangodb.com/3.2/Manual/Foxx/GraphQL.html) with your own copy of `graphql-sync` (or `graphql` 0.12 and later). Make sure to pass your copy of the module via the `graphql` argument.

### Using GraphQL-sync

Install GraphQL-sync from npm

```sh
npm install --save graphql-sync
```

GraphQL-sync provides two important capabilities: building a type schema, and
serving queries against that type schema.

First, build a GraphQL type schema which maps to your code base.

```js
import {
  graphql,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString
} from 'graphql-sync';

var schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'RootQueryType',
    fields: {
      hello: {
        type: GraphQLString,
        resolve() {
          return 'world';
        }
      }
    }
  })
});
```

This defines a simple schema with one type and one field, that resolves
to a fixed value. The `resolve` function can return a value, a promise,
or an array of promises.

Then, serve the result of a query against that type schema.

```js
var query = '{ hello }';

var result = graphql(schema, query);

// Prints
// {
//   data: { hello: "world" }
// }
console.log(result);
```

This runs a query fetching the one field defined. The `graphql` function will
first ensure the query is syntactically and semantically valid before executing
it, reporting errors otherwise.

```js
var query = '{ boyhowdy }';

var result = graphql(schema, query);

// Prints
// {
//   errors: [
//     { message: 'Cannot query field boyhowdy on RootQueryType',
//       locations: [ { line: 1, column: 3 } ] }
//   ]
// }
console.log(result);
```

### License

GraphQL is [BSD-licensed](https://github.com/graphql/graphql-js/blob/v0.10.3/LICENSE).
Facebook also provides an additional [patent grant](https://github.com/graphql/graphql-js/blob/v0.10.3/PATENTS).
