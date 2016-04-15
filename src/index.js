const gql = require('graphql');
module.exports = {
  graphql: require('./graphql').graphql,
  execute: require('./execution').execute,
  ...gql
};
