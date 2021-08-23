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

interface RepoTour {
    /** File name */
    name: string

    /** File path */
    path: string

    tour: SchemaForCodeTourTourFiles
}

/** relative filepath -> tour */
type RepoTours = Map<string, RepoTour>

/**
 * Values used in context key expressions.
 *
 * Pass to `sourcegraph.internal.updateContext`.
 */
interface CodeTourContext {
    ['codeTour.workspaceHasTours']: boolean
    [key: string]: string | number | boolean | null
}

/** Used to reset/initialize context */
const nullContext: CodeTourContext = {
    'codeTour.workspaceHasTours': false,
}

export function activate(context: sourcegraph.ExtensionContext): void {
    // TODO: If we want to add a recorder, move all this state + logic to a `Player` class.

    // repo URI to repo tours map
    const tourCache = new Map<string, RepoTours>()

    let currentRepoTours: RepoTours | null = null

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

    async function onCodeTourActionClicked(): Promise<void> {
        if (!currentRepoTours || currentRepoTours.size === 0) {
            // This shouldn't be the case if this action was clickable, but validate regardless.
            return
        }

        console.log('clicked code tour action', { currentRepoTours })
        // If there's only one tour for this workspace, open the panel and start it now.
        // Otherwise, show a promt w/ select (since such an element isn't exposed to extensions yet,
        // simulate it with an input box)
        if (currentRepoTours.size === 1) {
            console.log('can start tour')
        } else {
            const repoToursArray = [...currentRepoTours]

            const userInput = await sourcegraph.app.activeWindow?.showInputBox({
                prompt: 'Which tour do you want to start? Input the number',
                value: '1',
            })
            if (!userInput) {
                // The user escaped, don't start a tour
                return
            }
            // Validate that it is a number in range
            const choice = parseInt(userInput, 10)

            console.log({ userInput })
        }
    }

    async function onNewWorkspace(): Promise<void> {
        const requestID = ++currentRequestID
        try {
            // Reset context from previous workspaces/tours
            sourcegraph.internal.updateContext(nullContext)

            const repoTours = await getTours()

            if (requestID === currentRequestID) {
                currentRepoTours = repoTours
                // Update context

                const newContext: CodeTourContext = {
                    'codeTour.workspaceHasTours': repoTours ? repoTours.size > 0 : false,
                }

                sourcegraph.internal.updateContext(newContext)

                console.log({ requestID, currentRequestID, repoTours, size: repoTours?.size })
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
