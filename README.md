# Agente de Requisitos

Ferramenta inteligente para geração automatizada de artefatos de requisitos de software a partir de documentos de entrada (atas, levantamentos, especificações).

## O que faz

- **Extrai** funcionalidades de documentos (PDF, DOCX, TXT, MD)
- **Gera** Épicos → Features/UCs (com Fluxo Principal, Alternativos e Exceções) → Requisitos/HUs → Casos de Teste
- **Exporta** work items para o Azure DevOps (Épico → Feature → Requirement → Task)
- **Publica** documentação estruturada na Wiki do Azure DevOps, incluindo rastreabilidade RF → Fluxo Principal (coluna "Origem no Fluxo" na seção de Requisitos Funcionais)
- **Audita** integridade de referências (RN/RF/RNF): detecta lacunas e órfãos, sugere correções via IA e aplica em lote
- **Enriquece** Requisitos Funcionais (RF) e Não Funcionais (RNF) por épico via IA, com rastreabilidade ao Fluxo Principal
- **Migra** documentos existentes preservando o conteúdo original

## Stack

- React 19 + Vite 8
- Anthropic Claude API (Sonnet + Haiku)
- Azure DevOps REST API

## Como rodar localmente

```bash
npm install
npm run dev
```

Acesse `http://localhost:5173` e insira sua chave Anthropic (`sk-ant-...`).

## Deploy

O app está configurado para deploy no Vercel com proxy reverso para a Anthropic API e Azure DevOps.

## Documentação

Consulte o [FAQ](./FAQ.md) para entender a estratégia de decomposição de artefatos e sua relação com auditorias de conformidade (CMMI, MPS.BR, ISO/IEC 29148).
