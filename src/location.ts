import * as sourcegraph from 'sourcegraph'
import { determineStepType, getRepositoryFromRoots } from './code-tour'

import { SchemaForCodeTourTourFiles } from './codeTour'

/**
 * Creates a relative URL for new location "Previous/Next step" panel action items.
 *
 * Uses hash for position instead of the new query to maintain backward compatibility.
 * Use legacy fragment: https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/client/shared/src/util/url.ts#L385:31
 *
 * Sourcegraph location hashes are 1-based, like code tour positions.
 */
export function createRelativeSourcegraphURL(step: SchemaForCodeTourTourFiles['steps'][number]): string {
    const repository = getRepositoryFromRoots()

    if (!repository) {
        // Should never happen.
        throw new Error('No open repository found.')
    }

    const stepType = determineStepType(step)

    return (
        (() => {
            switch (stepType) {
                case 'directory':
                    return `/${repository}/-/tree/${step.directory!}`

                case 'file':
                    return `/${repository}/-/blob/${step.file!}`

                case 'line':
                    return `/${repository}/-/blob/${step.file!}#L${step.line!}`

                case 'selection': {
                    const { start, end } = step.selection!

                    if (start.line !== end.line) {
                        // Ignore character for multi-line ranges (not compatible with Sourcegraph web app)
                        return `/${repository}/-/blob/${step.file!}#L${start.line}-${end.line}`
                    }

                    if (start.character !== 0) {
                        // Ignore end, character ranges are not supported
                        return `/${repository}/-/blob/${step.file!}#L${step.line!}:${start.character}`
                    }

                    return `/${repository}/-/blob/${step.file!}#L${step.line!}`
                }

                case 'content':
                    throw new Error('Tried to create relative Sourcegraph URL for a content step.')
            }
        })() + '&tab=codeTour' // Keep tab open for all URL types
    )
}
