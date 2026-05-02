import {
  SEMANTIC_INJECTION_CALIBRATION_SET,
  calibrateSemanticInjectionClassifier,
} from '../src/index.js';

const results = calibrateSemanticInjectionClassifier(SEMANTIC_INJECTION_CALIBRATION_SET);
console.table(results);
