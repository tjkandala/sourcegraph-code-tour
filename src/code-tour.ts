import * as sourcegraph from 'sourcegraph'
import { SchemaForCodeTourTourFiles } from './codeTour'

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
                  name,
                  content
                }
              }
            }
          }
        }
      }`

type RepoTour = {
    /** File name */
    name: string

    /** File path */
    path: string

    tour: SchemaForCodeTourTourFiles
}

/** relative filepath -> tour */
type RepoTours = Map<string, RepoTour>

export function activate(context: sourcegraph.ExtensionContext): void {
    // repo URI to repo tours map
    const tourCache = new Map<string, RepoTours>()

    let currentRepoTours: RepoTour | null = null

    // Used for request cancellation (TODO: can we just use switchMap?)
    let currentRequestID = 0

    sourcegraph.commands.registerCommand('codeTour.selectTour', onCodeTourActionClicked)

    const panelView = sourcegraph.app.createPanelView('codeTour')
    panelView.title = 'Code Tour'
    panelView.content = 'LOADING...'

    // TODO: status bar item to keep track of tour, reopen panel

    // search for tour files on activation and whenever the opened repository changes.
    onNewWorkspace().catch(() => {})
    sourcegraph.workspace.rootChanges.subscribe(() => {
        onNewWorkspace().catch(() => {})
    })

    function onCodeTourActionClicked(): void {
        console.log('clicked code tour action', { currentRepoTours })
        // If there's only one tour for this workspace, open the panel and start it now.
        // Otherwise,
    }

    async function onNewWorkspace(): Promise<void> {
        const requestID = ++currentRequestID
        try {
            // Reset context from previous workspaces/tours

            const repoTours = await getTours()

            if (requestID === currentRequestID) {
                currentRepoTours = repoTours
                // Update context

                console.log({ requestID, currentRequestID, repoTours })
            }
        } catch {
            // noop TODO
        }
    }
}

interface SearchResult {
    search: {
        results: {
            results: { repository: { name: string }; file: { path: string; name: string; content: string } }[]
        }
    }
}

/**
 * Get tours and update panel view.
 * If there are tours for this repo, the action item will be enabled.
 * Otherwise, it will be disabled.
 */
async function getTours(): Promise<RepoTours | null> {
    try {
        const repository = getRepositoryFromRoots()
        if (!repository) {
            return null
        }

        const result = await sourcegraph.graphQL.execute<SearchResult, { searchQuery: string }>(tourFilesQuery, {
            searchQuery: createToursDirectoryQuery(repository),
        })

        const tourFiles = result.data?.search.results.results.map(result => result.file)

        if (!tourFiles || !tourFiles[0]) {
            return null
        }

        const toursByFile = tourFiles.reduce<Record<string, RepoTour>>((repoTours, tourFile) => {
            try {
                const tour: SchemaForCodeTourTourFiles = JSON.parse(tourFiles[0].content)

                repoTours[tourFile.path] = { ...tourFile, tour }
                return repoTours
            } catch {
                // invalid tour?
                return repoTours
            }
        }, {})

        return new Map(Object.entries(toursByFile))
    } catch (error) {
        console.error(error)
        return null
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
