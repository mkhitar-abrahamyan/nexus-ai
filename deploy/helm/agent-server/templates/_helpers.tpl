{{/* The release's base name, used as the prefix of every object. */}}
{{- define "agent-server.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Labels every object carries. */}}
{{- define "agent-server.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component: api, worker, or redis. */}}
{{- define "agent-server.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Where the Redis URL comes from: an existing Secret, the release's own Secret, or nothing. */}}
{{- define "agent-server.redisEnv" -}}
{{- if .Values.redis.existingSecret }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.redis.existingSecret }}
      key: {{ .Values.redis.secretKey }}
{{- else if or .Values.redis.deploy .Values.redis.url }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "agent-server.fullname" . }}
      key: redis-url
{{- end }}
{{- end -}}

{{/* The settings both tiers share. */}}
{{- define "agent-server.commonEnv" -}}
- name: PORT
  value: "8080"
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: IMAGE_TAG
  value: {{ .Values.image.tag | quote }}
- name: METRICS_PUBLIC
  value: {{ .Values.metrics.public | quote }}
{{- with .Values.tenants.maxActiveRuns }}
- name: TENANT_MAX_ACTIVE_RUNS
  value: {{ . | quote }}
{{- end }}
{{- with .Values.tenants.runsPerMinute }}
- name: TENANT_RUNS_PER_MINUTE
  value: {{ . | quote }}
{{- end }}
{{- with .Values.tenants.dailyBudgetUsd }}
- name: TENANT_DAILY_BUDGET_USD
  value: {{ . | quote }}
{{- end }}
{{- if .Values.auth.existingSecret }}
- name: SERVER_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.existingSecret }}
      key: {{ .Values.auth.tokenKey }}
{{- end }}
{{- include "agent-server.redisEnv" . }}
{{- end -}}

{{/* Probes and hardening both tiers share. */}}
{{- define "agent-server.container" -}}
image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
imagePullPolicy: {{ .Values.image.pullPolicy }}
ports:
  - name: http
    containerPort: 8080
# Draining answers 503 here, which takes the pod out of the Service before it stops.
readinessProbe:
  httpGet:
    path: /health
    port: http
  periodSeconds: 5
  failureThreshold: 1
# A TCP check, so a draining pod is not restarted for answering 503.
livenessProbe:
  tcpSocket:
    port: http
  periodSeconds: 15
  failureThreshold: 4
securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
{{- end -}}
