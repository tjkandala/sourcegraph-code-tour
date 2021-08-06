import mock from 'mock-require'
import { createStubSourcegraphAPI, createStubExtensionContext } from '@sourcegraph/extension-api-stubs'
const sourcegraph = createStubSourcegraphAPI()
mock('sourcegraph', sourcegraph)

import { activate } from './code-tour'

describe('code-tour', () => {
    it('should activate successfully', async () => {
        const context = createStubExtensionContext()
        await activate(context)
    })

    // TODO: test tour parsing
})
