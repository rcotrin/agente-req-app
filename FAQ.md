# FAQ — Agente de Requisitos: Por Que Trabalhamos Assim?

> **Público:** Equipe de operação, gestão e analistas de conformidade.
> **Finalidade:** Explicar a estratégia de decomposição de documentos de requisitos em múltiplos artefatos e sua relação com auditorias de mercado.

---

## Seção 1 — Para a Operação e Gestão

### 1.1 Por que um único documento vira tantos outros?

Quando recebemos uma ata de reunião, um documento de levantamento ou qualquer registro de necessidade de negócio, ele está escrito para ser **lido por humanos** — contém linguagem natural, ambiguidades e mistura diferentes níveis de detalhe (estratégico, tático e operacional) no mesmo texto.

Sistemas de software, equipes de desenvolvimento e ferramentas como o Azure DevOps precisam de informações **estruturadas e separadas por propósito**. Por isso o documento original é decomposto em:

| Artefato | Para quem serve | O que representa |
|----------|----------------|-----------------|
| **Épico** | Gestão / PO | Uma área de negócio completa (ex: Conciliação DDA) |
| **Feature / Caso de Uso** | Analista / Arquiteto | Um comportamento específico do sistema |
| **Requisito / História de Usuário** | Desenvolvedor | O que um tipo de usuário precisa fazer e por quê |
| **Caso de Teste** | QA | Como verificar se o que foi pedido foi entregue |

Cada um desses artefatos responde a uma pergunta diferente. Tentar responder todas no mesmo documento gera confusão, retrabalho e, principalmente, **impossibilidade de rastrear quem pediu o quê e por quê**.

---

### 1.2 O que significa "rastreabilidade"?

Rastreabilidade é a capacidade de responder perguntas como:

- *"Este requisito foi pedido por quem e está em qual documento?"*
- *"Se essa regra de negócio mudar, quais telas, testes e work items são afetados?"*
- *"Este caso de teste cobre qual necessidade de negócio?"*

Sem rastreabilidade, cada mudança exige um trabalho manual de investigação. Com ela, o impacto de qualquer alteração pode ser mapeado rapidamente.

---

### 1.3 Por que isso importa para auditorias?

Organizações que desenvolvem software para o mercado financeiro, saúde, governo ou que buscam certificações de qualidade são auditadas periodicamente. Os auditores verificam se existe evidência de que **cada requisito tem origem identificável e cobertura de teste comprovada**.

Sem isso, o apontamento mais comum é:

> *"Não foi possível rastrear o requisito REQ-042 até uma necessidade de negócio documentada."*

Esse tipo de apontamento pode bloquear homologações, certificações e contratos.

---

### 1.4 Qual é a limitação atual do processo e o que estamos fazendo sobre ela?

O processo atual gera artefatos bem estruturados e os vincula entre si (Épico → Feature → Requisito → Teste). A limitação conhecida é que **o elo de volta ao documento fonte** (qual seção da ata originou cada requisito) ainda não é registrado automaticamente.

Isso significa que, por enquanto, esse vínculo precisa ser mantido manualmente ou declarado no documento de origem. Estamos cientes dessa lacuna e ela está registrada como melhoria planejada.

---

## Seção 2 — Para Analistas e Auditores

### 2.1 Fundamentação normativa da abordagem

A decomposição de requisitos em artefatos hierárquicos segue as diretrizes de:

| Norma / Framework | Requisito relevante |
|-------------------|-------------------|
| **ISO/IEC/IEEE 29148:2018** | Exige rastreabilidade bidirecional entre necessidades de stakeholders, requisitos de sistema e requisitos de software |
| **CMMI for Development v2.0 — REQM** | SP 1.4: manter rastreabilidade bidirecional entre requisitos e produtos de trabalho |
| **MPS.BR nível G — GRE** | Cada requisito deve ter origem rastreável até uma necessidade de negócio documentada |
| **BABOK v3 — Requirements Life Cycle Management** | Rastreabilidade deve cobrir todo o ciclo de vida, do elicitado ao verificado |
| **UML 2.5.1** | Define os estereótipos `«trace»`, `«derive»` e `«refine»` para expressar relações entre artefatos de diferentes níveis de abstração |

---

### 2.2 O que o processo implementa hoje

#### Rastreabilidade vertical (forward)

```
Documento Fonte
    └── Épico (EP001)
            └── Feature / Caso de Uso (FT001)
                    ├── Fluxo Principal (FP-1, FP-2, FP-3...)
                    ├── Fluxos Alternativos (FA1, FA2, FA3)
                    ├── Fluxos de Exceção (FE1, FE2)
                    ├── Requisito / HU (REQ001, REQ002...)
                    │       └── Caso de Teste (CT-FT001-01, 02...)
                    ├── Regras de Negócio (RN-PREF-001...)
                    ├── Requisitos Funcionais (RF-PREF-001...)
                    └── Requisitos Não Funcionais (RNF-PREF-001...)
```

Cada artefato carrega referência explícita ao nível acima:
- `epicId` em todas as Features, Requisitos e CTs
- `ftId` / `ucId` em todos os Requisitos e CTs
- `reqId` nos Casos de Teste
- `origemPasso` nos Fluxos Alternativos e de Exceção (aponta para o passo do Fluxo Principal que os dispara)
- `origemPasso` nas Regras de Negócio (aponta para o passo do Fluxo Principal)
- RFs são vinculados a passos via `p.refs` (mecanismo "vincular" da auditoria); RNFs não possuem vínculo a passos específicos

#### Auditoria de referências (integridade interna)

O sistema executa verificação automática de:
- **Lacunas**: IDs de RN/RF/RNF citados nos fluxos mas não definidos nas HUs
- **Órfãos**: IDs definidos nas HUs mas nunca referenciados nos fluxos — inclui RF definidos mas ausentes de qualquer `p.refs`; RNF não são cobrados (sem vínculo obrigatório a passos)
- Itens resolvidos via "Resolver com IA" → "Aplicar Todos" somem da lista imediatamente (filtragem por `dismissedIds`)

#### Rastreabilidade RF → Fluxo Principal no wiki gerado

A Seção 10 (Requisitos Funcionais) do documento wiki exibe a coluna **"Origem no Fluxo"** com links reais para os passos que referenciam cada RF via `p.refs`. A Seção 6 (Fluxo Principal) lista tanto RN quanto RF vinculados na coluna Referências.

---

### 2.3 Refs fantasma e limpeza automática

O LLM pode gerar IDs de RN como placeholder (`RN001`, `RN002`) em `p.refs` sem que esses IDs existam nas regras de negócio reais. Para evitar que esses vínculos espúrios poluam a rastreabilidade:

- O prompt de geração de UCs usa `"refs":[]` como exemplo, eliminando o padrão que induzia a cópia literal de IDs fictícios.
- A função `limparRefFantasma()` varre todos os `p.refs` e remove IDs com prefixo `RN` não encontrados em nenhuma `hu.regrasNegocio`; preserva `RF-`, `RNF-` e `MSG-`.
- É aplicada automaticamente na geração normal de HUs, na migração e na regeneração com correção.

---

### 2.4 Lacuna conhecida e risco associado

| Lacuna | Norma impactada | Risco |
|--------|----------------|-------|
| Ausência de `«trace»` do artefato ao trecho do documento fonte | ISO 29148 §6.2.5, CMMI REQM SP 1.4 | Apontamento de rastreabilidade em auditoria de nível 2+ |
| Identificador de versão do documento fonte não registrado nos artefatos | CMMI REQM SP 1.3 | Impossibilidade de detectar impacto de mudanças no documento original |
| Matriz de rastreabilidade bidirecional não gerada automaticamente | MPS.BR GRE — resultado esperado RE4 | Auditoria manual necessária para cobrir o requisito normativo |

---

### 2.5 Por que mesmo assim esta abordagem é superior ao documento único

Utilizar um único documento como entrega final (ex: um PDF de especificação) cria riscos ainda maiores:

1. **Não há separação de audiência** — o mesmo documento precisa servir ao gestor, ao desenvolvedor e ao QA, inevitavelmente gerando ambiguidades.
2. **Não há cobertura de testes verificável** — não existe vínculo formal entre o que foi especificado e o que foi testado.
3. **Não há integração com o ciclo de desenvolvimento** — o documento fica como artefato morto, desconectado das ferramentas de gestão (Azure DevOps).
4. **Mudanças são invisíveis** — não existe histórico de versão por artefato, apenas por documento completo.

A abordagem decomposta, mesmo com a lacuna de rastreabilidade de origem, **reduz substancialmente o risco operacional** e cria uma base auditável que um documento único nunca oferece.

---

### 2.6 Plano de melhoria de conformidade

Para atingir conformidade plena com ISO 29148 e CMMI ML2/MPS.BR G, as seguintes melhorias estão planejadas:

- [ ] Registrar `origemDocumento` (arquivo, versão, seção) em cada artefato gerado
- [ ] Gerar matriz de rastreabilidade bidirecional como artefato de saída
- [ ] Implementar detecção de impacto: dado um documento atualizado, identificar quais artefatos precisam ser revisados
- [ ] Publicar hash SHA-256 do documento fonte junto aos artefatos gerados (imutabilidade de origem)

---

## Referências Normativas

- ISO/IEC/IEEE 29148:2018 — *Systems and software engineering — Life cycle processes — Requirements engineering*
- CMMI for Development v2.0 — *Requirements Management (REQM)*
- MPS.BR — Guia de Implementação — Parte 2: Nível G
- BABOK v3 — *Business Analysis Body of Knowledge* — Cap. 6: Requirements Life Cycle Management
- OMG UML 2.5.1 — *Unified Modeling Language Specification*, §7.8 (Dependencies)

---

*Documento mantido pelo time de Engenharia de Requisitos. Dúvidas: rafael.cotrin@ytecnologia.com*
