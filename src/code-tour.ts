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

export function activate(context: sourcegraph.ExtensionContext): void {
    // repo URI to tour filenames (or possibly the whole file?)
    const toursByRepo = new Map<string, string[]>()

    let currentRepoTours: any = undefined

    sourcegraph.commands.registerCommand('codeTour.selectTour', onCodeTourActionClicked)

    const panelView = sourcegraph.app.createPanelView('codeTour')
    panelView.title = 'Code Tour'
    panelView.content = 'LOADING...'

    // TODO: status bar item to keep track of tour, reopen panel

    // search for tour files on activation and whenever the opened repository changes.
    getTours()
        .then(tours => {
            currentRepoTours = tours
        })
        .catch(() => {
            // noop TODO
        })
    sourcegraph.workspace.rootChanges.subscribe(() => {
        getTours()
            .then(tours => {
                // TODO cancellation (without switchmap)
                currentRepoTours = tours
            })
            .catch(() => {
                // noop TODO
            })
    })

    function onCodeTourActionClicked(): void {
        console.log('clicked code tour action', { currentRepoTours })
        // If there's only one tour for this workspace, open the panel and start it now.
        // Otherwise,
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
async function getTours() {
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
            return
        }

        // parse each tour file. add valid files to map
        // TODO handle multiple tour files
        const tour: SchemaForCodeTourTourFiles = JSON.parse(tourFiles[0].content)
        tour.steps.map(step => console.log(step.file))
        console.log({ tour })

        return tourFiles
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
