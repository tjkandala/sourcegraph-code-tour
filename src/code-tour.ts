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

/**
 * Values used in context key expressions.
 *
 * Pass to `sourcegraph.internal.updateContext`.
 */
interface CodeTourContext {
    // TODO: better variables (union type)
    ['codeTour.workspaceHasTours']: boolean
    ['codeTour.workspaceHasOneTour']: boolean
    ['codeTour.workspaceHasMultipleTours']: boolean
    // Out of `currentRepoTours`
    ['codeTour.activeTourIndex']: number | null
    ['codeTour.activeTourTitle']: string | null
    ['codeTour.tourStep']: number | null
    ['codeTour.hasPrevStep']: boolean | null
    ['codeTour.hasNextStep']: boolean | null // Show "complete tour" action when false
}

/** Used to reset/initialize context */
const nullContext: CodeTourContext = {
    'codeTour.workspaceHasTours': false,
    'codeTour.workspaceHasOneTour': false,
    'codeTour.workspaceHasMultipleTours': false,
    'codeTour.activeTourIndex': null,
    'codeTour.activeTourTitle': null,
    'codeTour.tourStep': null,
    'codeTour.hasPrevStep': null,
    'codeTour.hasNextStep': null,
}

function updateContext(partialContext: Partial<CodeTourContext>): void {
    sourcegraph.internal.updateContext(partialContext as sourcegraph.ContextValues)
}

export function activate(context: sourcegraph.ExtensionContext): void {
    // TODO: If we want to add a recorder, move all this state + logic to a `Player` class.

    // repo URI to repo tours map
    const tourCache = new Map<string, RepoTour[]>()

    let currentRepoTours: RepoTour[] = []

    // Used for request cancellation (TODO: can we just use switchMap?)
    let currentRequestID = 0

    sourcegraph.commands.registerCommand('codeTour.selectTour', onSelectTour)
    sourcegraph.commands.registerCommand('codeTour.startTour', onStartTour)
    sourcegraph.commands.registerCommand('codeTour.prevStep', onPrevStep)
    sourcegraph.commands.registerCommand('codeTour.nextStep', onNextStep)

    const panelView = sourcegraph.app.createPanelView('codeTour')
    panelView.title = 'Code Tour'
    panelView.content = 'LOADING...'

    // TODO: status bar item to keep track of tour, reopen panel

    // search for tour files on activation and whenever the opened repository changes.
    onNewWorkspace().catch(() => {})
    sourcegraph.workspace.rootChanges.subscribe(() => {
        onNewWorkspace().catch(() => {})
    })

    /**
     *
     * Called "in code" for multi-tour repos, called as a panel action item command for single-tour repos.
     * Selects first tour by default
     */
    function onStartTour(tourIndex = 0): void {
        const { tour } = currentRepoTours[tourIndex] || {}
        if (!tour) {
            return
        }
        console.log('started tour!', tour)
        updateContext({
            'codeTour.activeTourIndex': tourIndex,
            'codeTour.activeTourTitle': tour.title,
            'codeTour.tourStep': 0,
            'codeTour.hasPrevStep': false,
            'codeTour.hasNextStep': true,
        })

        // Render step to panel
    }

    function onPrevStep(currentStep: number): void {
        // TODO
    }

    function onNextStep(activeTourIndex: number, currentStep: number): void {
        // TODO
        // const tour = currentRepoTours[]
        console.log('step', { activeTourIndex, currentStep })
    }

    async function onSelectTour(): Promise<void> {
        if (!currentRepoTours || currentRepoTours.length === 0) {
            // This shouldn't be the case if this action was clickable, but validate regardless.
            return
        }

        // format prompt with repo tour names
        const titles = currentRepoTours.map(repoTour => repoTour.tour.title).join('\n')

        const userInput = await sourcegraph.app.activeWindow?.showInputBox({
            prompt: 'Which tour do you want to start? Input the number\n\n' + titles,
            value: '1',
        })
        if (!userInput) {
            // The user escaped, don't start a tour
            return
        }

        try {
            const tourIndex = parseInt(userInput, 10) - 1

            // TODO: Validate that it is a number in range
            onStartTour(tourIndex)
        } catch (error) {
            console.error(error)
            // Not a valid choice. Show notification to user?
            return
        }
    }

    async function onNewWorkspace(): Promise<void> {
        const requestID = ++currentRequestID
        try {
            // Reset context from previous workspaces/tours
            updateContext(nullContext)

            const repoTours = (await getTours()) ?? []

            if (requestID === currentRequestID) {
                currentRepoTours = repoTours

                // Populate panel. If there are multiple tours, add "select tour to play" action.
                // Otherwise, just show the start of the tour?

                if (repoTours.length > 1) {
                    let content = '## Available code tours\n'

                    content += repoTours
                        .map(({ tour }) => `1. **${tour.title}**` + (tour.description ? `\n${tour.description}\n` : ''))
                        .join('\n')

                    panelView.content = content
                } else if (repoTours.length === 1) {
                    panelView.content =
                        `## ${repoTours[0].tour.title}` +
                        (repoTours[0].tour.description ? `\n${repoTours[0].tour.description}\n` : '')
                }

                // Update context

                updateContext({
                    'codeTour.workspaceHasTours': repoTours.length > 0,
                    'codeTour.workspaceHasOneTour': repoTours.length === 1,
                    'codeTour.workspaceHasMultipleTours': repoTours.length > 1,
                    'codeTour.activeTourIndex': null,
                    'codeTour.activeTourTitle': null,
                    'codeTour.tourStep': null,
                })

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
async function getTours(): Promise<RepoTour[] | null> {
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

        return tourFiles
            .map(tourFile => {
                try {
                    const tour: SchemaForCodeTourTourFiles = JSON.parse(tourFile.content)

                    // TODO: git ref association. don't display tours that aren't valid
                    // at this commit
                    const repoTour: RepoTour = { ...tourFile, tour }
                    return repoTour
                } catch {
                    // invalid tour?
                    return null
                }
            })
            .filter((tour): tour is Exclude<RepoTour | null, null> => tour !== null)
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
