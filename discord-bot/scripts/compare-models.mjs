import { readFileSync } from 'node:fs';
import { lockedHoldout } from '../src/signals/modelLab.js';

const [trainingPath, testPath] = process.argv.slice(2);
if (!trainingPath || !testPath) throw new Error('Usage: node scripts/compare-models.mjs EARLIER_REPORT LATER_REPORT');
const training = JSON.parse(readFileSync(trainingPath, 'utf8'));
const test = JSON.parse(readFileSync(testPath, 'utf8'));
if (!(training.exportedAt < test.exportedAt)) throw new Error('Training report must precede the test report');
console.log(JSON.stringify({ trainingExport: training.exportedAt, testExport: test.exportedAt,
  experiments: [600, 300, 120].map((horizon) => lockedHoldout(training.observations, test.observations, { horizon })),
}, null, 2));
