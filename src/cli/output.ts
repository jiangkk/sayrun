import { dataLines, report } from './presentation.ts';

export const printJson = (data: unknown) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
export const print = (data: unknown, json = false, title = '命令结果') => json ? printJson(data) : report(title, dataLines(data));
