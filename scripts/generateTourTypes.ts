import { createWriteStream, writeFileSync } from 'fs'
import { get } from 'https'

import { compileFromFile } from 'json-schema-to-typescript'

const CODETOUR_JSON_SCHEMA_URL = 'https://cdn.jsdelivr.net/gh/vsls-contrib/code-tour/schema.json'
const jsonFilePath = __dirname + '/schema.json'
const typesFilePath = __dirname + '/../src/codeTour.d.ts'

get(CODETOUR_JSON_SCHEMA_URL, response => {
    response.pipe(createWriteStream(jsonFilePath))
    response.on('close', () => {
        // Generate types
        compileFromFile(jsonFilePath)
            .then(types => writeFileSync(typesFilePath, types))
            .catch(error => console.error(error))
    })
})
