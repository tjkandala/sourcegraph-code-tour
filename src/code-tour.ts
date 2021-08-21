import * as sourcegraph from 'sourcegraph'

/**
 * Creates the search query used to find code tour directories within a repository.
 *
 * https://marketplace.visualstudio.com/items?itemName=vsls-contrib.codetour#tour-files
 * */
const createToursDirectoryQuery = (repository: string): string =>
    // eslint-disable-next-line no-useless-escape
    `file:\.tours\/(.*).tour$ repo:${repository} patterntype:regexp`

const tourFilesQuery = `query TourFiles($searchQuery: String) {
        search(query: $searchQuery) {
          results {
            results {
              ... on FileMatch {
                repository {
                      name
                },
                file {
                  path,
                  name
                }
              }
            }
          }
        }
      }`

export function activate(context: sourcegraph.ExtensionContext): void {
    // repo URI to tour filenames (or possibly the whole file?)
    const toursByRepo = new Map<string, string[]>()

    // search for tour files on activation and whenever the opened repository changes.
    getTours().catch(() => {
        // noop TODO
    })
    sourcegraph.workspace.rootChanges.subscribe(() => {
        getTours().catch(() => {
            // noop TODO
        })
    })

    context.subscriptions.add(
        sourcegraph.languages.registerHoverProvider(['*'], {
            provideHover: () => ({
                contents: {
                    value: 'Hello world from code-tour! 🎉🎉🎉',
                    kind: sourcegraph.MarkupKind.Markdown,
                },
            }),
        })
    )
}

interface SearchResult {
    search: {
        results: {
            results: { repository: { name: string }; file: { path: string; name: string } }[]
        }
    }
}

async function getTours() {
    try {
        const repository = getRepositoryFromRoots()
        if (!repository) {
            return null
        }

        const result = await sourcegraph.graphQL.execute<SearchResult, { searchQuery: string }>(tourFilesQuery, {
            searchQuery: createToursDirectoryQuery(repository),
        })

        console.log({ repository, result })
        result.data?.search.results.results.map(result => console.log(result.file.path))
    } catch (error) {
        console.error(error)
    }
}

function getRepositoryFromRoots(): string | null {
    const workspaceRoot: sourcegraph.WorkspaceRoot | undefined = sourcegraph.workspace.roots[0]

    if (!workspaceRoot) {
        return null
    }

    return workspaceRoot.uri.host + workspaceRoot.uri.pathname
}

// Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
