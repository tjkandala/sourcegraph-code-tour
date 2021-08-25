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

    switch (stepType) {
        case 'directory':
            return `/${repository}/-/tree/${step.directory!}#tab=codeTour`

        case 'file':
            return `/${repository}/-/blob/${step.file!}#tab=codeTour`

        case 'line':
            return `/${repository}/-/blob/${step.file!}#L${step.line!}&tab=codeTour`

        case 'selection': {
            const { start, end } = step.selection!

            if (start.line !== end.line) {
                // Ignore character for multi-line ranges (not compatible with Sourcegraph web app)
                return `/${repository}/-/blob/${step.file!}#L${start.line}-${end.line}&tab=codeTour`
            }

            if (start.character !== 0) {
                // Ignore end, character ranges are not supported
                return `/${repository}/-/blob/${step.file!}#L${step.line!}:${start.character}&tab=codeTour`
            }

            return `/${repository}/-/blob/${step.file!}#L${step.line!}&tab=codeTour`
        }

        case 'content':
            throw new Error('Tried to create relative Sourcegraph URL for a content step.')
    }
}

/**
 * Derived from Sourcegraph's `parseRepoURI`:
 * https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/client/shared/src/util/url.ts#L171:60
 */
export function parseRepoURI(uri: string): {
    repoName: string
    revision: string | undefined
    commitID: string | undefined
    filePath: string | undefined
    position: UIPosition | undefined
    range: UIRange | undefined
} {
    const parsed = new URL(uri)
    const repoName = parsed.hostname + decodeURIComponent(parsed.pathname)
    const revision = decodeURIComponent(parsed.search.slice('?'.length)) || undefined
    let commitID: string | undefined
    if (revision?.match(/[\dA-f]{40}/)) {
        commitID = revision
    }
    const fragmentSplit = parsed.hash.slice('#'.length).split(':').map(decodeURIComponent)
    let filePath: string | undefined
    let position: UIPosition | undefined
    let range: UIRange | undefined
    if (fragmentSplit.length === 1) {
        filePath = fragmentSplit[0]
    }
    if (fragmentSplit.length === 2) {
        filePath = fragmentSplit[0]
        const rangeOrPosition = fragmentSplit[1]
        const rangeOrPositionSplit = rangeOrPosition.split('-')

        if (rangeOrPositionSplit.length === 1) {
            position = parsePosition(rangeOrPositionSplit[0])
        }
        if (rangeOrPositionSplit.length === 2) {
            range = { start: parsePosition(rangeOrPositionSplit[0]), end: parsePosition(rangeOrPositionSplit[1]) }
        }
        if (rangeOrPositionSplit.length > 2) {
            throw new Error('unexpected range or position: ' + rangeOrPosition)
        }
    }
    if (fragmentSplit.length > 2) {
        throw new Error('unexpected fragment: ' + parsed.hash)
    }

    return { repoName, revision, commitID, filePath: filePath || undefined, position, range }
}

const parsePosition = (string: string): Position => {
    const split = string.split(',')
    if (split.length === 1) {
        return { line: parseInt(string, 10), character: 0 }
    }
    if (split.length === 2) {
        return { line: parseInt(split[0], 10), character: parseInt(split[1], 10) }
    }
    throw new Error('unexpected position: ' + string)
}

/**
 * A position in a document.
 *
 * @see module:sourcegraph.Position
 */
export interface Position {
    /** Zero-based line number. */
    readonly line: number

    /** Zero-based character on a line. */
    readonly character: number
}

/**
 * 1-indexed position in a blob.
 * Positions in URLs are 1-indexed.
 */
interface UIPosition {
    /** 1-indexed line number */
    line: number

    /** 1-indexed character number */
    character: number
}

/**
 * 1-indexed range in a blob.
 * Ranges in URLs are 1-indexed.
 */
interface UIRange {
    start: UIPosition
    end: UIPosition
}
