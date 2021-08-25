import { EMPTY, from, of } from 'rxjs'
import { map, switchMap } from 'rxjs/operators'
import * as sourcegraph from 'sourcegraph'

import { SchemaForCodeTourTourFiles } from './codeTour'
import { createRelativeSourcegraphURL, parseRepoURI } from './location'

/**
 * Creates the search query used to find code tour directories within a repository.
 *
 * https://marketplace.visualstudio.com/items?itemName=vsls-contrib.codetour#tour-files
 * */
const createToursDirectoryQuery = (repository: string, revision: string): string =>
    // eslint-disable-next-line no-useless-escape
    `file:\.tours\/(.*).tour$ repo:${repository}$@${revision} patterntype:regexp`

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
    ['codeTour.showPrevStepNewLocation']: boolean | null
    ['codeTour.prevStepURL']: string | null
    ['codeTour.showPrevStepSameLocation']: boolean | null
    ['codeTour.showNextStepNewLocation']: boolean | null
    ['codeTour.nextStepURL']: string | null
    ['codeTour.showNextStepSameLocation']: boolean | null
    ['codeTour.showCompleteTour']: boolean | null
}

/** Used to reset/initialize context */
const nullContext: CodeTourContext = {
    'codeTour.workspaceHasTours': false,
    'codeTour.workspaceHasOneTour': false,
    'codeTour.workspaceHasMultipleTours': false,
    'codeTour.activeTourIndex': null,
    'codeTour.activeTourTitle': null,
    'codeTour.tourStep': null,
    'codeTour.showPrevStepNewLocation': null,
    'codeTour.prevStepURL': null,
    'codeTour.showPrevStepSameLocation': null,
    'codeTour.showNextStepNewLocation': null,
    'codeTour.nextStepURL': null,
    'codeTour.showNextStepSameLocation': null,
    'codeTour.showCompleteTour': null,
}

export function activate(context: sourcegraph.ExtensionContext): void {
    // TODO: If we want to add a recorder, move all this state + logic to a `Player` class.
    // TODO: potentially cache tours by repo
    // TODO: status bar item to keep track of tour, reopen panel

    let currentRepoTours: RepoTour[] = []

    // Keep copy of context in scope
    let currentContext: CodeTourContext = nullContext
    function updateContext(partialContext: Partial<CodeTourContext>): void {
        currentContext = { ...currentContext, ...partialContext }
        sourcegraph.internal.updateContext(currentContext as any)
    }

    // Used for request cancellation (TODO: can we just use switchMap?)
    let currentRequestID = 0

    sourcegraph.commands.registerCommand('codeTour.selectTour', onSelectTour)
    sourcegraph.commands.registerCommand('codeTour.startTour', onStartTour)
    sourcegraph.commands.registerCommand('codeTour.prevStepSameLocation', onPreviousStepSameLocation)
    sourcegraph.commands.registerCommand('codeTour.nextStepSameLocation', onNextStepSameLocation)
    sourcegraph.commands.registerCommand('codeTour.completeTour', onCompleteTour)

    const panelView = sourcegraph.app.createPanelView('codeTour')
    panelView.title = 'Code Tour'
    panelView.content = 'LOADING...'

    // Search for tour files on activation and whenever the opened repository changes.
    onNewWorkspace().catch(() => {})
    sourcegraph.workspace.rootChanges.subscribe(() => {
        onNewWorkspace().catch(() => {})
    })

    // Observe location changes to see if it may be a result of step navigation.
    context.subscriptions.add(
        from(sourcegraph.app.activeWindow!.activeViewComponentChanges)
            .pipe(
                switchMap(activeViewComponent => {
                    if (activeViewComponent?.type === 'DirectoryViewer') {
                        return of({ type: 'tree' as const, uri: activeViewComponent.directory.uri })
                    }

                    if (activeViewComponent?.type === 'CodeEditor') {
                        return from(activeViewComponent.selectionsChanges).pipe(
                            map(() => ({
                                type: 'blob' as const,
                                uri: activeViewComponent.document.uri,
                                selection: activeViewComponent.selection,
                            }))
                        )
                    }

                    return EMPTY
                })
            )
            .subscribe(locationUpdate => {
                onLocationUpdate(locationUpdate)
            })
    )
    /**
     * Check whether the latest location matches either the previous or next step.
     * If so, it's likely that the user clicked the "Previous step" or "Next step"
     * actions, so handle that step (rendering, context updates, etc).
     */
    function onLocationUpdate(
        locationUpdate:
            | {
                  type: 'tree'
                  uri: URL
              }
            | {
                  type: 'blob'
                  uri: string
                  selection: sourcegraph.Selection | null
              }
    ): void {
        const activeTourIndex = currentContext['codeTour.activeTourIndex']
        const currentStepIndex = currentContext['codeTour.tourStep']
        if (activeTourIndex === null || currentStepIndex === null) {
            return
        }
        const { tour } = currentRepoTours[activeTourIndex]

        const stepActions = [
            { action: 'prev' as const, stepIndex: currentStepIndex - 1 },
            { action: 'next' as const, stepIndex: currentStepIndex + 1 },
        ]

        let matchedStepAction: 'prev' | 'next' | null = null

        for (const { action, stepIndex } of stepActions) {
            const step = tour.steps[stepIndex]
            if (!step) {
                continue
            }
            const stepType = determineStepType(step)

            if (stepType === 'content') {
                // Location wouldn't change for a content step
                continue
            }

            if (locationUpdate.type === 'tree') {
                if (stepType !== 'directory') {
                    continue
                }
                // TODO unify with files by using parseRepoURI
                if (locationUpdate.uri.hash.slice(1) === step.directory!) {
                    matchedStepAction = action
                    break
                }
            } else {
                if (stepType === 'directory') {
                    continue
                }

                if (stepType === 'file') {
                    const isEqual = step.file === locationUpdate.uri // todo parse relative file path out of uri
                    if (isEqual) {
                        matchedStepAction = action
                        break
                    }
                } else {
                    // Turn line into Range as well so that it can be compared with a Selection (which is a subclass of Range).
                    // "Line Ranges" in Sourcegraph (one line, no characters) look like this: {end: {line: N, character: 0}, start: {line: N, character: 0}}
                    const stepRange =
                        stepType === 'line'
                            ? new sourcegraph.Range(
                                  new sourcegraph.Position(step.line! - 1, 0),
                                  new sourcegraph.Position(step.line! - 1, 0)
                              )
                            : new sourcegraph.Range(
                                  new sourcegraph.Position(
                                      step.selection!.start.line - 1,
                                      step.selection!.start.character - 1
                                  ),
                                  new sourcegraph.Position(
                                      step.selection!.end.line - 1,
                                      step.selection!.end.character - 1
                                  )
                              )

                    const isEqual = locationUpdate.selection?.isEqual(stepRange)

                    if (isEqual) {
                        matchedStepAction = action
                        break
                    }
                }
            }
        }

        if (matchedStepAction !== null) {
            onStepUpdate({ activeTourIndex, currentStepIndex, action: matchedStepAction })
        }
    }

    /**
     * Used to determine whether "Previous step" or "Next step" actions are links to different locations
     * or trigger commands to update the panel.
     *
     * Call this when:
     * - Starting code tour
     * - Clicked prev or next step action for same location
     * - We determine that the user clicked a location-changing prev or next step action, so we can update context
     *
     * TODO: consider revision when comparing location?
     */
    function isStepLocationSame({
        activeTourIndex,
        baseStepIndex,
        newStepIndex,
    }: {
        activeTourIndex: number
        baseStepIndex: number
        newStepIndex: number
    }): boolean {
        const { tour } = currentRepoTours[activeTourIndex]
        const baseStep = tour.steps[baseStepIndex]
        const newStep = tour.steps[newStepIndex]

        const baseStepType: StepType = determineStepType(baseStep)
        const newStepType: StepType = determineStepType(newStep)

        if (baseStepType !== newStepType) {
            if (newStepType === 'content') {
                return true // There's nowhere to link to, treat it like the location is the same.
            }

            if (baseStepType === 'content') {
                // Check if the current location is the same as the new step location.
                // This can happen if, for example, the user navigates to a line step and back to a content step.
                // The panel should update without a location change on action.

                if (newStepType === 'directory') {
                    const maybeDirectoryView = sourcegraph.app.activeWindow!.activeViewComponent
                    if (maybeDirectoryView && maybeDirectoryView.type === 'DirectoryViewer') {
                        // TODO unify with files by using parseRepoURI
                        return newStep.directory === maybeDirectoryView.directory.uri.hash.slice(1)
                    }
                } else {
                    const maybeCodeEditor = sourcegraph.app.activeWindow!.activeViewComponent
                    if (maybeCodeEditor && maybeCodeEditor.type === 'CodeEditor') {
                        const { filePath } = parseRepoURI(maybeCodeEditor.document.uri)

                        if (newStepType === 'file') {
                            return filePath === newStep.file!
                        }
                        if (newStepType === 'line') {
                            // Ensure that the selection is not a range.
                            return !!(
                                maybeCodeEditor.selection?.isSingleLine &&
                                // Editor positions are 1-indexed
                                maybeCodeEditor.selection.start.line + 1 === newStep.line!
                            )
                        }
                        if (newStepType === 'selection' && maybeCodeEditor.selection) {
                            return (
                                // Editor positions are 1-indexed
                                maybeCodeEditor.selection.start.character + 1 === newStep.selection?.start.character &&
                                maybeCodeEditor.selection.start.character + 1 === newStep.selection?.start.character &&
                                maybeCodeEditor.selection.end.line + 1 === newStep.selection?.end.line &&
                                maybeCodeEditor.selection.end.character + 1 === newStep.selection?.end.character
                            )
                        }
                    }
                }
            }

            // We don't need to do any futher comparison
            return false
        }

        switch (baseStepType) {
            case 'file':
                return baseStep.file === newStep.file

            case 'line':
                return baseStep.line === newStep.line

            case 'directory':
                return baseStep.directory === newStep.directory

            case 'selection':
                return (
                    baseStep.selection?.start.line === newStep.selection?.start.line &&
                    baseStep.selection?.start.character === newStep.selection?.start.character &&
                    baseStep.selection?.end.line === newStep.selection?.end.line &&
                    baseStep.selection?.end.character === newStep.selection?.end.character
                )

            case 'content':
                // Content steps should be rendered in the same location.
                return true
        }

        // TODO: consider pattern
    }

    /**
     * Render step to panel (TODO and status bar)
     */
    function renderStep({ activeTourIndex, stepIndex }: { activeTourIndex: number; stepIndex: number }): void {
        const repoTour = currentRepoTours[activeTourIndex]
        if (!repoTour) {
            // render error?
            return
        }
        const step = repoTour.tour.steps[stepIndex]
        if (!step) {
            // render error?
            return
        }

        let content = ` ${step.title ? `${step.title}: ` : ''}***${stepIndex + 1} of ${
            repoTour.tour.steps.length
        }***\n\n`

        content += step.description

        panelView.content = content
    }

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

        updateContext({
            'codeTour.activeTourIndex': tourIndex,
            'codeTour.activeTourTitle': tour.title,
        })
        onStepUpdate({ activeTourIndex: tourIndex, currentStepIndex: -1, action: 'next' })
    }

    function onCompleteTour(): void {
        updateContext(nullContext)
        handleRepoTours()
        // TODO more carefully consider post-finish state
    }

    /**
     * Shared between all step updates, whether in the same location or a new location
     *
     */
    function onStepUpdate({
        activeTourIndex,
        currentStepIndex,
        action,
    }: {
        activeTourIndex: number
        currentStepIndex: number
        action: 'prev' | 'next'
    }): void {
        const newCurrentStepIndex = currentStepIndex + (action === 'next' ? 1 : -1)
        const newPreviousStepIndex = newCurrentStepIndex - 1
        const newNextStepIndex = newCurrentStepIndex + 1

        const newContext: Partial<CodeTourContext> = {
            'codeTour.tourStep': newCurrentStepIndex,
            'codeTour.showCompleteTour': false, // override in one branch
        }

        const { tour } = currentRepoTours[activeTourIndex]

        const newPreviousStep = tour.steps[newPreviousStepIndex]
        if (newPreviousStep) {
            // Determine what the "Previous step" button should do once the step has been updated.
            const previousStepSameLocation = isStepLocationSame({
                activeTourIndex,
                baseStepIndex: newCurrentStepIndex,
                newStepIndex: newPreviousStepIndex,
            })

            if (previousStepSameLocation) {
                newContext['codeTour.showPrevStepNewLocation'] = false
                newContext['codeTour.showPrevStepSameLocation'] = true
                newContext['codeTour.prevStepURL'] = null
            } else {
                newContext['codeTour.showPrevStepNewLocation'] = true
                newContext['codeTour.showPrevStepSameLocation'] = false
                newContext['codeTour.prevStepURL'] = createRelativeSourcegraphURL(newPreviousStep)
            }
        } else {
            // Don't show the "Previous step" action if there is no previous step.
            newContext['codeTour.showPrevStepNewLocation'] = false
            newContext['codeTour.showPrevStepSameLocation'] = false
            newContext['codeTour.prevStepURL'] = null
        }

        const newNextStep = tour.steps[newNextStepIndex]
        if (newNextStep) {
            // Determine what the "Next step" button should do once the step has been updated.
            const nextStepSameLocation = isStepLocationSame({
                activeTourIndex,
                baseStepIndex: newCurrentStepIndex,
                newStepIndex: newNextStepIndex,
            })

            if (nextStepSameLocation) {
                newContext['codeTour.showNextStepNewLocation'] = false
                newContext['codeTour.showNextStepSameLocation'] = true
                newContext['codeTour.nextStepURL'] = null
            } else {
                newContext['codeTour.showNextStepNewLocation'] = true
                newContext['codeTour.showNextStepSameLocation'] = false
                newContext['codeTour.nextStepURL'] = createRelativeSourcegraphURL(newNextStep)
            }
        } else {
            // Don't show the "Next step" action if there are no remaining steps.
            newContext['codeTour.showNextStepNewLocation'] = false
            newContext['codeTour.showNextStepSameLocation'] = false
            newContext['codeTour.nextStepURL'] = null
            newContext['codeTour.showCompleteTour'] = true // TODO decide whether to always show this
        }

        renderStep({ activeTourIndex, stepIndex: newCurrentStepIndex })
        updateContext(newContext)
    }

    function onPreviousStepSameLocation(activeTourIndexString: string, currentStepIndexString: string): void {
        const activeTourIndex = parseInt(activeTourIndexString, 10)
        const currentStepIndex = parseInt(currentStepIndexString, 10)

        onStepUpdate({ activeTourIndex, currentStepIndex, action: 'prev' })
    }

    function onNextStepSameLocation(activeTourIndexString: string, currentStepIndexString: string): void {
        const activeTourIndex = parseInt(activeTourIndexString, 10)
        const currentStepIndex = parseInt(currentStepIndexString, 10)

        onStepUpdate({ activeTourIndex, currentStepIndex, action: 'next' })
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
                handleRepoTours()
            }
        } catch {
            // noop TODO
        }
    }

    /**
     * Called when tours have been fetched or a tour has been completed/cancelled.
     */
    function handleRepoTours(): void {
        const repoTours = currentRepoTours
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

        updateContext({
            'codeTour.workspaceHasTours': repoTours.length > 0,
            'codeTour.workspaceHasOneTour': repoTours.length === 1,
            'codeTour.workspaceHasMultipleTours': repoTours.length > 1,
            'codeTour.activeTourIndex': null,
            'codeTour.activeTourTitle': null,
            'codeTour.tourStep': null,
        })
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
        const repositoryInfo = getRepositoryInfoFromRoots()
        if (!repositoryInfo) {
            return null
        }
        const result = await sourcegraph.graphQL.execute<SearchResult, { searchQuery: string }>(tourFilesQuery, {
            searchQuery: createToursDirectoryQuery(repositoryInfo.repository, repositoryInfo.revision),
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

type StepType = 'line' | 'selection' | 'directory' | 'file' | 'content'

export function determineStepType(step: SchemaForCodeTourTourFiles['steps'][number]): StepType {
    if (step.file) {
        if (typeof step.line === 'number') {
            return 'line'
        }

        if (step.selection) {
            return 'selection'
        }

        return 'file'
    }

    if (step.directory) {
        return 'directory'
    }

    return 'content'
}

export function getRepositoryInfoFromRoots(): { repository: string; revision: string } | null {
    const workspaceRoot: sourcegraph.WorkspaceRoot | undefined = sourcegraph.workspace.roots[0]

    if (!workspaceRoot) {
        return null
    }

    return {
        repository: workspaceRoot.uri.host + workspaceRoot.uri.pathname,
        revision: workspaceRoot.uri.search.slice(1),
    }
}

// Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
