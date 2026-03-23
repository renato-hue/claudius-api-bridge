/**
 * AuditPIS/RVM Platform — API Bridge
 * Ponte entre o browser (localStorage) e o n8n (Claudius COO).
 *
 * Estratégia: Google Duet AI — dados acessíveis fora do browser
 * para que a IA possa monitorar 24/7.
 *
 * Porta: 3001
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// === FUNÇÕES UTILITÁRIAS ===
function readStore(ns) {
  const file = path.join(DATA_DIR, `${ns}.json`);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return {}; }
}
function writeStore(ns, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${ns}.json`), JSON.stringify(data, null, 2));
}

// === SSE: plataforma recebe updates do Claudius em tempo real ===
const clients = new Set();
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
function broadcast(ns, data) {
  const msg = `data: ${JSON.stringify({ namespace: ns, data, timestamp: new Date().toISOString() })}\n\n`;
  clients.forEach(c => { try { c.write(msg); } catch {} });
}
function broadcastEvent(event) {
  const msg = `event: claudius_event\ndata: ${JSON.stringify(event)}\n\n`;
  clients.forEach(c => { try { c.write(msg); } catch {} });
}

// === ROTAS DE SINCRONIZAÇÃO (chamadas pela plataforma) ===

// Plataforma envia snapshot completo de um namespace
app.post('/sync/:namespace', (req, res) => {
  writeStore(req.params.namespace, req.body);
  broadcast(req.params.namespace, req.body);
  console.log(`[SYNC] ${req.params.namespace} — ${JSON.stringify(req.body).length} bytes`);
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Plataforma envia evento específico (state change, alert, etc.)
app.post('/events', (req, res) => {
  const events = readStore('events');
  const list = events._list || [];
  list.push({ ...req.body, receivedAt: new Date().toISOString() });
  // Manter últimos 500 eventos
  events._list = list.slice(-500);
  writeStore('events', events);
  broadcastEvent(req.body);
  console.log(`[EVENT] ${req.body.type || req.body.action || 'unknown'} — ${req.body.clienteNome || ''}`);
  res.json({ ok: true });
});

// === ROTAS DE LEITURA (chamadas pelo n8n) ===

// Leitura completa de um namespace
app.get('/data/:namespace', (req, res) => {
  res.json(readStore(req.params.namespace));
});

// Projetos com filtros
app.get('/projetos', (req, res) => {
  const store = readStore('rvm_proj_data');
  const projetos = store.projetos || [];
  const { status, tipo, responsavel } = req.query;
  const filtered = projetos.filter(p => {
    if (status && p.status !== status) return false;
    if (tipo && p.tipoProjeto !== tipo) return false;
    if (responsavel && p.responsavelPrincipal !== responsavel) return false;
    return true;
  });
  res.json(filtered);
});

// Projeto individual
app.get('/projetos/:id', (req, res) => {
  const store = readStore('rvm_proj_data');
  const projeto = (store.projetos || []).find(p => String(p.id) === req.params.id);
  if (!projeto) return res.status(404).json({ error: 'Projeto não encontrado' });
  res.json(projeto);
});

// Alertas ativos
app.get('/alertas', (req, res) => {
  const store = readStore('rvm_alertas');
  const ativos = (store._list || []).filter(a => !a.resolvido);
  res.json(ativos);
});

// Métricas consolidadas para briefing
app.get('/metricas/resumo', (req, res) => {
  const projStore = readStore('rvm_proj_data');
  const projetos = projStore.projetos || [];
  const ativos = projetos.filter(p => p.status === 'ATIVO' || p.status === 'EM_EXECUCAO');
  const encerrados = projetos.filter(p => p.status === 'ENCERRADO');

  // Procurações vencendo em 30 dias
  const hoje = new Date();
  const procVencendo = projetos.filter(p => {
    if (!p.procuracao || !p.procuracao.dataValidade) return false;
    const dias = Math.ceil((new Date(p.procuracao.dataValidade) - hoje) / 86400000);
    return dias >= 0 && dias <= 30;
  });

  // Aguardando aprovação
  const aguardandoAprov = projetos.filter(p =>
    p.etapaAtual === 'Aprovação Interna' || p.etapaAtual === 'Estratégia e Aprovação'
  );

  // SLAs vencidos
  const slasVencidos = projetos.filter(p => {
    if (!p._stateEnteredAt || !p._stateEnteredAt[p.etapaAtual]) return false;
    // Pegar SLA do estado (simplificado — idealmente viria da state machine)
    const slaMap = { 'Proposta Comercial': 14, 'Contrato': 7, 'Procuração': 5, 'Coleta de Documentos': 21, 'Análise dos Documentos': 10, 'Revisão da Apuração': 15, 'Relatório Final': 7, 'Aprovação Interna': 3, 'Apresentação ao Cliente': 14, 'Escrituração EFD': 30 };
    const sla = slaMap[p.etapaAtual];
    if (!sla) return false;
    const dias = Math.floor((hoje - new Date(p._stateEnteredAt[p.etapaAtual])) / 86400000);
    return dias > sla;
  });

  // Valor total em carteira
  const valorCarteira = projetos.reduce((s, p) =>
    s + ((p.resultadosAuditoria || {}).totalCreditosIdentificados || 0), 0);

  res.json({
    totalProjetos: projetos.length,
    projetosAtivos: ativos.length,
    projetosEncerrados: encerrados.length,
    procuracoesVencendo30Dias: procVencendo.length,
    procuracoesDetalhes: procVencendo.map(p => ({
      cliente: p.clienteNome, vencimento: p.procuracao.dataValidade,
      diasRestantes: Math.ceil((new Date(p.procuracao.dataValidade) - hoje) / 86400000)
    })),
    aguardandoAprovacao: aguardandoAprov.length,
    aguardandoDetalhes: aguardandoAprov.map(p => ({ cliente: p.clienteNome, numero: p.numeroProjeto })),
    slasVencidos: slasVencidos.length,
    slasDetalhes: slasVencidos.map(p => ({
      cliente: p.clienteNome, etapa: p.etapaAtual,
      dias: Math.floor((hoje - new Date(p._stateEnteredAt[p.etapaAtual])) / 86400000)
    })),
    valorTotalEmCarteira: valorCarteira,
    /* Resumo por tipo */
    auditorias: projetos.filter(p => p.tipoProjeto === 'AUDITORIA_CREDITOS').length,
    gestaoPassivo: projetos.filter(p => p.tipoProjeto === 'REESTRUTURACAO_DIVIDA').length,
    timestamp: new Date().toISOString()
  });
});

// Eventos recentes (n8n usa para monitor tempo real)
app.get('/events/recent', (req, res) => {
  const events = readStore('events');
  const list = events._list || [];
  const since = req.query.since
    ? new Date(req.query.since)
    : new Date(Date.now() - 5 * 60 * 1000);
  res.json(list.filter(e => new Date(e.receivedAt) > since));
});

// === ROTAS DE ESCRITA (n8n → plataforma) ===

// n8n cria tarefa
app.post('/tarefas', (req, res) => {
  const store = readStore('rvm_tarefas');
  const list = store._list || [];
  const id = `claudius_${Date.now()}`;
  list.push({ id, ...req.body, criadoEm: new Date().toISOString(), source: 'CLAUDIUS_COO' });
  store._list = list;
  writeStore('rvm_tarefas', store);
  broadcast('tarefas', { type: 'TASK_CREATED', task: list[list.length - 1] });
  res.json({ ok: true, id });
});

// n8n marca alerta como processado
app.patch('/alertas/:id/processar', (req, res) => {
  const store = readStore('rvm_alertas');
  const list = store._list || [];
  const alerta = list.find(a => a.id === req.params.id);
  if (alerta) {
    alerta.processadoPorClaudius = true;
    alerta.dataProcessamento = new Date().toISOString();
    writeStore('rvm_alertas', store);
  }
  res.json({ ok: true });
});

// Claudius envia mensagem para exibir no painel da plataforma
app.post('/claudius/mensagem', (req, res) => {
  const store = readStore('claudius_feed');
  const list = store._list || [];
  list.push({ ...req.body, timestamp: new Date().toISOString() });
  store._list = list.slice(-100); // manter últimas 100 mensagens
  writeStore('claudius_feed', store);
  broadcastEvent({ type: 'CLAUDIUS_MESSAGE', payload: req.body });
  res.json({ ok: true });
});

// Memória do Claudius
app.get('/claudius/memory', (req, res) => {
  res.json(readStore('claudius_memory'));
});
app.post('/claudius/memory', (req, res) => {
  const current = readStore('claudius_memory');
  const updated = { ...current, ...req.body, ultimaAtualizacao: new Date().toISOString() };
  writeStore('claudius_memory', updated);
  res.json({ ok: true });
});

// === IMPORTAÇÃO AUTOMÁTICA (Claudius importa documentos do Google Drive) ===

// Fila de importação — documentos a processar
app.post('/importar/documento', (req, res) => {
  /* Recebe documento classificado pelo Claude + dados extraídos.
     Salva no store para que a plataforma consuma via polling ou SSE. */
  const store = readStore('import_queue');
  const list = store._list || [];
  const id = `import_${Date.now()}`;
  const entry = {
    id,
    ...req.body, // tipo, dados extraídos, arquivo original
    status: 'PENDENTE', // PENDENTE → IMPORTADO → VERIFICADO → ERRO
    criadoEm: new Date().toISOString(),
    source: 'CLAUDIUS_DRIVE'
  };
  list.push(entry);
  store._list = list;
  writeStore('import_queue', store);

  // Inserir diretamente nos dados da plataforma se for parcelamento
  if (req.body.tipo === 'EXTRATO_PARCELAMENTO') {
    const tpData = readStore('platform_data');
    const tp = tpData.tp_data || { clientes: [], parcelamentos: [], usuarios: [] };

    const d = req.body.dados;
    if (d && d.cnpj && d.numNegociacao) {
      // Verificar duplicata
      const existe = tp.parcelamentos.find(p => p.numNegociacao === d.numNegociacao);
      if (!existe) {
        // Criar/encontrar cliente
        const cnpjClean = (d.cnpj || '').replace(/\D/g, '');
        let cli = tp.clientes.find(c => (c.cnpj || '').replace(/\D/g, '') === cnpjClean);
        if (!cli) {
          cli = { id: Date.now(), nome: d.nome || 'Importado por Claudius', cnpj: d.cnpj };
          tp.clientes.push(cli);
        }
        // Criar parcelamento
        tp.parcelamentos.push({
          id: Date.now() + 1,
          clienteId: cli.id,
          orgao: d.orgao || 'RFB',
          modalidade: d.modalidade || '',
          numNegociacao: d.numNegociacao,
          numParcelas: d.numParcelas || 0,
          valorConsolidado: d.valorConsolidado || 0,
          valorParcela: d.valorParcela || 0,
          situacao: d.situacao || 'Em parcelamento',
          dataInicio: d.dataInicio || '',
          formaPagamento: d.formaPagamento || 'DARF',
          parcelas: d.parcelas || []
        });
        tpData.tp_data = tp;
        writeStore('platform_data', tpData);
        entry.status = 'IMPORTADO';
        entry.parcelamentoId = Date.now() + 1;
        console.log(`[IMPORT] Parcelamento ${d.numNegociacao} importado para ${d.nome}`);
      } else {
        entry.status = 'DUPLICADO';
        entry.mensagem = 'Parcelamento já existe: ' + d.numNegociacao;
      }
    }
  }

  // Atualizar fila
  writeStore('import_queue', store);
  broadcastEvent({ type: 'DOCUMENT_IMPORTED', id, tipo: req.body.tipo, status: entry.status });
  res.json({ ok: true, id, status: entry.status });
});

// Verificar importação — compara dados extraídos vs salvos
app.post('/verificar/importacao/:id', (req, res) => {
  const store = readStore('import_queue');
  const list = store._list || [];
  const entry = list.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Importação não encontrada' });

  const verificacao = req.body; // { campos_corretos: [...], campos_errados: [...], score: 0-100 }
  entry.verificacao = verificacao;
  entry.status = verificacao.score >= 90 ? 'VERIFICADO' : 'ERRO_VERIFICACAO';
  entry.verificadoEm = new Date().toISOString();
  writeStore('import_queue', store);

  if (entry.status === 'ERRO_VERIFICACAO') {
    broadcastEvent({
      type: 'IMPORT_VERIFICATION_FAILED',
      id: entry.id,
      campos_errados: verificacao.campos_errados,
      mensagem: `Importação ${entry.id} falhou na verificação (score: ${verificacao.score}/100)`
    });
  }

  res.json({ ok: true, status: entry.status, score: verificacao.score });
});

// Fila de importação — consultar status
app.get('/importar/fila', (req, res) => {
  const store = readStore('import_queue');
  res.json((store._list || []).slice(-20));
});

// Auto-fix: Claudius reporta bug para Claude Code corrigir
app.post('/autofix/reportar', (req, res) => {
  const store = readStore('autofix_queue');
  const list = store._list || [];
  const id = `fix_${Date.now()}`;
  list.push({
    id,
    ...req.body, // descricao, arquivo, funcao, esperado, obtido
    status: 'PENDENTE',
    criadoEm: new Date().toISOString()
  });
  store._list = list;
  writeStore('autofix_queue', store);
  console.log(`[AUTOFIX] Bug reportado: ${req.body.descricao}`);
  res.json({ ok: true, id });
});

// Auto-fix: consultar fila
app.get('/autofix/fila', (req, res) => {
  const store = readStore('autofix_queue');
  res.json((store._list || []).slice(-10));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Claudius API Bridge', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🧠 Claudius API Bridge rodando em http://localhost:${PORT}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
