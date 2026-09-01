# Repositório de Apps — PCP Corporativo

Hub central (arquivo único `index.html`, sem backend) que lista todas as ferramentas da área e linka para cada uma.

## Como adicionar um novo tema/box

Abra `index.html`, encontre o array `APPS` (dentro da tag `<script>`) e copie um objeto existente como modelo:

```js
{ id:'meu-tema', title:'Nome do App', cat:'estoque', status:'soon',
  desc:'Descrição curta do que o app faz.',
  icon:'database', url:'' },
```

- **cat**: uma das chaves em `CATEGORIES` (abastecimento, planejamento, estoque, qualidade, cadastro, financeiro, projeto). Cada categoria já tem uma cor própria — todos os cards da mesma categoria puxam a mesma identidade visual automaticamente.
- **status**: `live` (ativo, clicável) · `dev` (em desenvolvimento) · `soon` (planejado).
- **icon**: uma das chaves do objeto `ICONS` no topo do script (chart, calculator, truck, cloud, alert, boxx, file, activity, shield, target, wallet, calclock, database, calrange, lock, refresh, kanban). Dá para adicionar novos ícones incluindo mais uma entrada nesse objeto (formato SVG, mesmo padrão dos existentes).
- **url**: link do app já publicado. Enquanto não houver deploy, deixe `''` — o card fica com status "planejado"/"em desenvolvimento" e não é clicável.

Os contadores do topo (App ativo / Em desenvolvimento / Planejados), os chips de filtro e o card fantasma "+" no fim da grade são gerados automaticamente — não precisa mexer neles.

## Boxes híbridos (um card com vários sub-apps dentro)

Para temas que vão reunir múltiplas ferramentas menores (ex: um futuro box **Pessoas** com PDI, Avaliação de Desempenho, Férias etc.), use o campo `children` em vez de `url`:

```js
{ id:'pessoas', title:'Pessoas', cat:'projeto', status:'dev', icon:'database',
  desc:'Central dos temas de gente da área.',
  children:[
    { title:'PDI', status:'live', url:'https://...' },
    { title:'Avaliação de Desempenho', status:'soon', url:'' },
  ] },
```

O card vira um "box guarda-chuva": ao clicar, expande um painel com os sub-apps em vez de navegar direto. Há um exemplo comentado no próprio arquivo, logo após o array `APPS`.

## Deploy

Este é um app 100% estático (um `index.html`). Pode subir direto na Vercel (ou Netlify/GitHub Pages) sem nenhuma configuração — é só apontar a raiz do projeto para esta pasta.

**Importante:** o card "Torre de Controle — Compras MP" aponta hoje para `../torre-de-controle-compras-mp/index.html` (link relativo, só funciona testando os dois arquivos lado a lado no computador). Assim que a Torre de Controle for publicada como projeto separado na Vercel, troque o campo `url` desse app pela URL real (ex: `https://torre-compras-mp.vercel.app`).
