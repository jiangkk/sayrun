import { write } from '../terminal/display.ts';

export const printJson = (data: unknown) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
export const print = (data: unknown, json = false) => json ? printJson(data) : write(typeof data === 'string' ? data + '\n' : JSON.stringify(data, null, 2) + '\n');
