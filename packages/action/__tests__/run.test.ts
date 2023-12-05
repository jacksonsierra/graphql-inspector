import { expect } from 'vitest';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { fileLoader } from '../src/files.js';
import { getAssociatedPullRequest } from '../src/git.js';
import { run } from '../src/run.js';

vi.mock('../src/checks');
vi.mock('../src/git');
vi.mock('../src/files');

const mockFileLoader = fileLoader as vi.MockedFunction<typeof fileLoader>;
const mockGetAssociatedPullRequest = getAssociatedPullRequest as vi.MockedFunction<
  typeof getAssociatedPullRequest
>;

describe('Inspector Action', () => {
  const mockLoadFile = vi.fn();
  let coreInfoSpy;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock error/warning/info/debug
    coreInfoSpy = vi.spyOn(core, 'info').mockImplementation(vi.fn());

    vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
      switch (name) {
        case 'github-token':
          return 'MOCK_GITHUB_TOKEN';
        case 'schema':
          return 'master:schema.graphql';
        default:
          return '';
      }
    });

    vi.spyOn(github, 'getOctokit').mockReturnValue({
      checks: {
        create: vi.fn().mockResolvedValue({
          data: {
            id: '2',
          },
        }),
      },
    });
    vi.spyOn(github.context, 'repo', 'get').mockImplementation(() => {
      return {
        owner: 'some-owner',
        repo: 'graphql-inspector',
      };
    });

    mockGetAssociatedPullRequest.mockResolvedValue({
      state: 'open',
      number: 1,
      base: {
        ref: 'master',
      },
    });
    mockFileLoader.mockReturnValue(mockLoadFile);

    process.env.GITHUB_WORKSPACE = '/workspace';
  });

  describe('rules', () => {
    it('should accept a rules list with 1 built in rule', async () => {
      vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
        switch (name) {
          case 'github-token':
            return 'MOCK_GITHUB_TOKEN';
          case 'schema':
            return 'master:schema.graphql';
          case 'rules':
            return `
        suppressRemovalOfDeprecatedField
        `;
          default:
            return '';
        }
      });

      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            oldQuery: OldType @deprecated(reason: "use newQuery")
            newQuery: Int!
          }

          type OldType {
            field: String!
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            newQuery: Int!
          }
        `);

      await run();

      expect(coreInfoSpy).toBeCalledWith('Conclusion: success');
      expect(coreInfoSpy).toBeCalledWith(expect.stringContaining('Found 2 changes'));
    });

    it('should accept a rules list with 1 custom rule', async () => {
      vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
        switch (name) {
          case 'github-token':
            return 'MOCK_GITHUB_TOKEN';
          case 'schema':
            return 'master:schema.graphql';
          case 'rules':
            // This rule turns all changes from breaking to dangerous
            return `
        example/rules/custom-rule.js
        `;
          default:
            return '';
        }
      });

      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            oldQuery: OldType @deprecated(reason: "use newQuery")
            newQuery: Int!
          }

          type OldType {
            field: String!
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            newQuery: Int!
          }
        `);

      await run();

      expect(coreInfoSpy).toBeCalledWith('Conclusion: success');
      expect(coreInfoSpy).toBeCalledWith(expect.stringContaining('Found 2 changes'));
    });

    it('should accept a rules list with a built-in and a custom rule', async () => {
      vi.spyOn(core, 'getInput').mockImplementation((name: string, _options) => {
        switch (name) {
          case 'github-token':
            return 'MOCK_GITHUB_TOKEN';
          case 'schema':
            return 'master:schema.graphql';
          case 'rules':
            return `
          suppressRemovalOfDeprecatedField
          example/rules/custom-rule.js
          `;
          default:
            return '';
        }
      });

      mockLoadFile
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            oldQuery: OldType @deprecated(reason: "use newQuery")
            newQuery: Int!
          }

          type OldType {
            field: String!
          }
        `)
        .mockResolvedValueOnce(/* GraphQL */ `
          type Query {
            newQuery: Int!
          }
        `);

      await run();

      expect(coreInfoSpy).toBeCalledWith('Conclusion: success');
      expect(coreInfoSpy).toBeCalledWith(expect.stringContaining('Found 2 changes'));
    });
  });
});
