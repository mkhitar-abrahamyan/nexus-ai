import { SEMANTIC_INJECTION_CALIBRATION_SET, calibrateSemanticInjectionClassifier } from 'nexus-ai-pro/security';

const results = calibrateSemanticInjectionClassifier(SEMANTIC_INJECTION_CALIBRATION_SET);
console.table(results);
