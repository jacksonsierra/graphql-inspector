import { extname } from 'path';
import { buildClientSchema, GraphQLSchema, printSchema, Source } from 'graphql';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { Rule } from '@graphql-inspector/core';
import { fileLoader } from './files.js';
import { getAssociatedPullRequest, getCurrentCommitSha } from './git.js';
import { diff } from './helpers/diff.js';
import { produceSchema } from './helpers/schema.js';
import { CheckConclusion } from './helpers/types.js';
import { createSummary } from './helpers/utils.js';
import { castToBoolean, getInputAsArray, resolveRule } from './utils.js';

export async function run() {
  core.info(`GraphQL Inspector started`);

  // env
  let ref = process.env.GITHUB_SHA!;
  const commitSha = getCurrentCommitSha();

  core.info(`Ref: ${ref}`);
  core.info(`Commit SHA: ${commitSha}`);

  const token = core.getInput('github-token', { required: true });
  const jobName = core.getInput('name') || 'GraphQL Inspector';

  let workspace = process.env.GITHUB_WORKSPACE;

  if (!workspace) {
    return core.setFailed('Failed to resolve workspace directory. GITHUB_WORKSPACE is missing');
  }

  const useMerge = castToBoolean(core.getInput('experimental_merge'), true);
  const failOnBreaking = castToBoolean(core.getInput('fail-on-breaking'));
  const approveLabel: string = core.getInput('approve-label') || 'approved-breaking-change';
  const rulesList = getInputAsArray('rules') || [];
  const onUsage = core.getInput('getUsage');

  const octokit = github.getOctokit(token);

  // repo
  const { owner, repo } = github.context.repo;

  // pull request
  const pullRequest = await getAssociatedPullRequest(octokit, commitSha);

  core.info(`Creating a job named "${jobName}"`);

  const schemaPointer = core.getInput('schema', { required: true });

  const loadFile = fileLoader({
    octokit,
    owner,
    repo,
  });

  if (!schemaPointer) {
    core.error('No `schema` variable');
    return core.setFailed('Failed to find `schema` variable');
  }

  const rules = rulesList
    .map(r => {
      const rule = resolveRule(r);

      if (!rule) {
        core.error(`Rule ${r} is invalid. Did you specify the correct path?`);
      }

      return rule;
    })
    .filter(Boolean) as Rule[];

  // Different lengths mean some rules were resolved to undefined
  if (rules.length !== rulesList.length) {
    return core.setFailed("Some rules weren't recognised");
  }

  let config;

  if (onUsage) {
    const checkUsage = require(onUsage);

    if (checkUsage) {
      config = {
        checkUsage,
      };
    }
  }

  let [schemaRef, schemaPath] = schemaPointer.split(':');

  if (useMerge && pullRequest?.state === 'open') {
    ref = `refs/pull/${pullRequest.number}/merge`;
    workspace = undefined;
    core.info(`EXPERIMENTAL - Using Pull Request ${ref}`);

    const baseRef = pullRequest.base?.ref;

    if (baseRef) {
      schemaRef = baseRef;
      core.info(`EXPERIMENTAL - Using ${baseRef} as base schema ref`);
    }
  }

  const [oldFile, newFile] = await Promise.all([
    loadFile({
      ref: schemaRef,
      path: schemaPath,
    }),
    loadFile({
      path: schemaPath,
      ref,
      workspace,
    }),
  ]);

  core.info('Got both sources');

  let oldSchema: GraphQLSchema;
  let newSchema: GraphQLSchema;
  let sources: { new: Source; old: Source };

  if (extname(schemaPath.toLowerCase()) === '.json') {
    oldSchema = buildClientSchema(JSON.parse(oldFile));
    newSchema = buildClientSchema(JSON.parse(newFile));

    sources = {
      old: new Source(printSchema(oldSchema), `${schemaRef}:${schemaPath}`),
      new: new Source(printSchema(newSchema), schemaPath),
    };
  } else {
    sources = {
      old: new Source(oldFile, `${schemaRef}:${schemaPath}`),
      new: new Source(newFile, schemaPath),
    };

    oldSchema = produceSchema(sources.old);
    newSchema = produceSchema(sources.new);
  }

  const schemas = {
    old: oldSchema,
    new: newSchema,
  };

  core.info(`Built both schemas`);

  core.info(`Start comparing schemas`);

  const action = await diff({
    path: schemaPath,
    schemas,
    sources,
    rules,
    config,
  });

  let conclusion = action.conclusion;
  const changes = action.changes || [];

  core.setOutput('changes', String(changes.length || 0));
  core.info(`Changes: ${changes.length || 0}`);

  const hasApprovedBreakingChangeLabel = pullRequest?.labels?.some(
    (label: any) => label.name === approveLabel,
  );

  // Force Success when failOnBreaking is disabled
  if (
    (failOnBreaking === false || hasApprovedBreakingChangeLabel) &&
    conclusion === CheckConclusion.Failure
  ) {
    core.info('FailOnBreaking disabled. Forcing SUCCESS');
    conclusion = CheckConclusion.Success;
  }

  const summary = createSummary(changes, 100, false);

  core.info(`Conclusion: ${conclusion}`);

  if (conclusion === CheckConclusion.Failure) {
    core.error(summary);
    return core.setFailed('Something is wrong with your schema');
  }

  core.info(summary);
}
