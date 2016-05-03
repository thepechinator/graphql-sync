const gql = require('graphql');
module.exports = {
  ...gql,
  graphql: require('./graphql').graphql,
  execute: require('./execution').execute
};
