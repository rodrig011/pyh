import { readFileSync } from 'node:fs';
import { compareExitPolicies } from '../src/signals/exitReplay.js';

const paths = process.argv.slice(2);
if (paths.length < 2) throw new Error('Usage: node scripts/compare-exits.mjs EARLIER_REPORT [EARLIER_REPORT...] LATER_REPORT');
const reports = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
const later = reports.pop();
console.log(JSON.stringify(compareExitPolicies(reports, later), null, 2));
