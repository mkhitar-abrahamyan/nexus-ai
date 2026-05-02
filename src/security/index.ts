import type { CompletionRequest } from '../types/messages.js';
import type { SecurityConfig, SecurityFinding, SecurityLevel, SecurityResult } from '../types/security.js';
import { SchemaValidator } from './schema-validator.js';
import { InjectionDetector } from './injection-detector.js';
import { PIIDetector } from './pii-detector.js';
import { OutputGuard } from './output-guard.js';
import { InputGuard } from './input-guard.js';
import type { NexusResponse } from '../types/response.js';
import { SemanticInjectionClassifier } from './semantic-injection-classifier.js';

export class NexusSecurityError extends Error {
  constructor(public findings: SecurityFinding[]) {
    super(`NexusAI security blocked request: ${findings.map((f) => f.message).join('; ')}`);
    this.name = 'NexusSecurityError';
  }
}

export class SecurityPipeline {
  private schemaValidator = new SchemaValidator();
  private injectionDetector = new InjectionDetector();
  private piiDetector = new PIIDetector();
  private outputGuard = new OutputGuard();
  private inputGuard = new InputGuard();
  private semanticInjectionClassifier?: SemanticInjectionClassifier;

  constructor(private config: SecurityLevel | SecurityConfig = 'standard') {}

  protectInput(request: CompletionRequest): SecurityResult<CompletionRequest> {
    const normalized = this.normalizeConfig();
    const level = normalized.level || 'standard';

    if (level === 'off') {
      return { ok: true, value: request, findings: [], guardrailsApplied: [] };
    }

    let safeRequest = request;
    const findings: SecurityFinding[] = [];
    const guardrailsApplied: string[] = [];

    const schemaFindings = this.schemaValidator.validate(safeRequest);
    findings.push(...schemaFindings);
    guardrailsApplied.push('schema-validation');

    const inputGuardResult = this.inputGuard.protect(safeRequest, normalized);
    safeRequest = inputGuardResult.value;
    findings.push(...inputGuardResult.findings);
    guardrailsApplied.push(...inputGuardResult.guardrailsApplied);

    if (this.shouldRunInjectionDetection(level, normalized)) {
      const injectionConfig = normalized.input?.injectionDetection || {};
      const injectionFindings = this.injectionDetector.detect(safeRequest, injectionConfig);
      findings.push(...injectionFindings);
      guardrailsApplied.push('prompt-injection-detection');

      if (injectionConfig.semantic?.enabled) {
        // Semantic classifier uses dependency-free hash embeddings unless a custom classifier is used directly.
        const classifier = this.semanticInjectionClassifier || new SemanticInjectionClassifier(injectionConfig.semantic);
        this.semanticInjectionClassifier = classifier;
        const semanticFindings = classifier.detectSync(safeRequest);
        findings.push(...semanticFindings);
        guardrailsApplied.push('semantic-prompt-injection-detection');
      }

      if (injectionFindings.length > 0 && injectionConfig.onDetection === 'transform') {
        safeRequest = this.injectionDetector.neutralize(safeRequest);
        guardrailsApplied.push('prompt-injection-neutralization');
      }
    }

    if (this.shouldRunPII(level, normalized)) {
      const piiConfig = normalized.input?.pii || {};
      const piiFindings = this.piiDetector.detect(safeRequest, piiConfig);
      findings.push(...piiFindings);
      guardrailsApplied.push('pii-detection');

      const action = piiConfig.action || (level === 'strict' || level === 'paranoid' ? 'mask' : 'flag');
      if (piiFindings.length > 0 && action === 'mask') {
        safeRequest = this.piiDetector.mask(safeRequest, piiConfig);
        guardrailsApplied.push('pii-masking');
      }
    }

    const blockingFindings = this.getBlockingFindings(findings, level, normalized);

    return {
      ok: blockingFindings.length === 0,
      value: safeRequest,
      findings,
      guardrailsApplied,
    };
  }

  assertSafe(result: SecurityResult<CompletionRequest>): void {
    if (!result.ok) {
      throw new NexusSecurityError(result.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high'));
    }
  }

  protectOutput(response: NexusResponse): SecurityResult<NexusResponse> {
    const normalized = this.normalizeConfig();
    const level = normalized.level || 'standard';

    if (level === 'off') {
      return { ok: true, value: response, findings: [], guardrailsApplied: [] };
    }

    return this.outputGuard.protect(response, normalized);
  }

  private normalizeConfig(): SecurityConfig {
    if (typeof this.config === 'string') return { level: this.config };
    return this.applyPreset(this.config);
  }

  private applyPreset(config: SecurityConfig): SecurityConfig {
    if (!config.preset) return config;

    const presetConfigs: Record<string, SecurityConfig> = {
      developer: { level: 'standard' },
      startup: { level: 'strict', output: { piiRedaction: true, maxContentLength: 12000 } },
      enterprise: {
        level: 'strict',
        input: {
          injectionDetection: { enabled: true, onDetection: 'block' },
          pii: { enabled: true, action: 'mask', preserveFormat: true },
        },
        output: { piiRedaction: true, maxContentLength: 8000 },
      },
      healthcare: {
        level: 'paranoid',
        input: {
          injectionDetection: { enabled: true, onDetection: 'block' },
          pii: { enabled: true, action: 'block' },
        },
        output: { piiRedaction: true, maxContentLength: 6000 },
      },
      finance: {
        level: 'paranoid',
        input: {
          injectionDetection: { enabled: true, onDetection: 'block' },
          pii: { enabled: true, action: 'mask', detect: ['email', 'phone', 'credit-card', 'aws-key', 'private-key'] },
        },
        output: { piiRedaction: true, maxContentLength: 6000 },
      },
    };

    const preset = presetConfigs[config.preset] || {};
    return {
      ...preset,
      ...config,
      input: { ...preset.input, ...config.input },
      output: { ...preset.output, ...config.output },
    };
  }

  private shouldRunInjectionDetection(level: SecurityLevel, config: SecurityConfig): boolean {
    if (config.input?.injectionDetection?.enabled === false) return false;
    return level === 'standard' || level === 'strict' || level === 'paranoid';
  }

  private shouldRunPII(level: SecurityLevel, config: SecurityConfig): boolean {
    if (config.input?.pii?.enabled === false) return false;
    return level === 'standard' || level === 'strict' || level === 'paranoid';
  }

  private getBlockingFindings(findings: SecurityFinding[], level: SecurityLevel, config: SecurityConfig): SecurityFinding[] {
    const injectionAction = config.input?.injectionDetection?.onDetection || (level === 'strict' || level === 'paranoid' ? 'block' : 'flag');
    const piiAction = config.input?.pii?.action || (level === 'paranoid' ? 'block' : 'flag');

    return findings.filter((finding) => {
      if (finding.type === 'schema') return true;
      if (finding.type === 'prompt-injection') return injectionAction === 'block' && (finding.severity === 'critical' || finding.severity === 'high');
      if (finding.type === 'pii') return piiAction === 'block' && (finding.severity === 'critical' || finding.severity === 'high');
      if (finding.type === 'content-length') return finding.severity === 'high' || finding.severity === 'critical';
      if (finding.type === 'secret') return (config.input?.secrets?.action || 'block') === 'block' && (finding.severity === 'critical' || finding.severity === 'high');
      if (finding.type === 'url-risk') return (config.input?.urls?.action || 'flag') === 'block' && (finding.severity === 'critical' || finding.severity === 'high');
      if (finding.type === 'tool-policy') return true;
      return false;
    });
  }
}

export { SchemaValidator } from './schema-validator.js';
export { InjectionDetector } from './injection-detector.js';
export { PIIDetector } from './pii-detector.js';
export { OutputGuard } from './output-guard.js';
export { InputGuard } from './input-guard.js';
export { SemanticInjectionClassifier } from './semantic-injection-classifier.js';
