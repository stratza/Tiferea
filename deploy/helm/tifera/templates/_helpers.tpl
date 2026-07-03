{{- define "tifera.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "tifera.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "tifera.labels" -}}
app: {{ include "tifera.fullname" . }}
app.kubernetes.io/name: {{ include "tifera.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "tifera.selectorLabels" -}}
app: {{ include "tifera.fullname" . }}
{{- end -}}

{{- define "tifera.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
