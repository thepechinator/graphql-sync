const gql = require('graphql');
const execution = require('./execution');
module.exports = {
  ...gql,
  graphql: require('./graphql').graphql,
  execute: execution.execute,
  defaultFieldResolver: execution.defaultFieldResolver,
  responsePathAsArray: execution.responsePathAsArray
};
