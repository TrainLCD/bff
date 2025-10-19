#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaPath = resolve(__dirname, '../schema.graphql');
const outputPath = resolve(__dirname, '../src/schema.ts');

try {
	const schemaContent = readFileSync(schemaPath, 'utf-8');
	
	const output = `// This file is auto-generated from schema.graphql
// DO NOT EDIT MANUALLY - run: npm run schema:generate

export const schemaSDL = /* GraphQL */ \`
${schemaContent}\`;
`;

	writeFileSync(outputPath, output, 'utf-8');
	console.log('✅ Schema generated successfully at src/schema.ts');
} catch (error) {
	console.error('❌ Failed to generate schema:', error);
	process.exit(1);
}
