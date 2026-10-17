import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../platform/paths.ts';

export const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
