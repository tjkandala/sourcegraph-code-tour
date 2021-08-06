import * as sourcegraph from 'sourcegraph'

// implement parseRepoURI

export function activate(context: sourcegraph.ExtensionContext): void {
    // repo URI to tour filenames (or possibly the whole file?)
    const toursByRepo = new Map<string, string[]>()

    // search for /.tour directory for each open repository.

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

// Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
