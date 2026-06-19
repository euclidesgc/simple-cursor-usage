# Guia de publicação — Cursor Usage for Teams

Passo a passo para publicar esta extensão nos marketplaces, do zero.

> **Contexto importante (a extensão é para o Cursor):** o Cursor **não usa** o
> Visual Studio Marketplace da Microsoft (a licença da MS restringe o uso aos
> produtos dela). O Cursor instala extensões do **Open VSX Registry** (mantido
> pela Eclipse Foundation). Ou seja: **se você publicar só no VS Marketplace,
> ninguém no Cursor consegue instalar.** Para o público desta extensão, o
> **Open VSX é o que importa**; o VS Marketplace é o bônus para quem usa VS Code.
> Recomenda-se publicar **nos dois**, com prioridade no Open VSX.

> _Nota de data: este guia foi escrito em junho de 2026. Veja o aviso sobre a
> descontinuação dos PATs do Azure DevOps em 1º/12/2026 na Parte 3._

> 🔒 **Segurança:** este guia usa apenas *placeholders* (`<SEU_TOKEN>`, `<PAT>`).
> Os tokens reais (PAT do Azure DevOps e token do Open VSX) **nunca** devem ser
> commitados nem colados em arquivos do repositório — guarde-os em um gerenciador
> de segredos ou em *secrets* de CI/CD.

## Índice

- [Parte 0 — Contas necessárias](#parte-0--contas-necessárias)
- [Parte 1 — Preparar a extensão](#parte-1--preparar-a-extensão-ajustes-obrigatórios)
- [Parte 2 — Publicar no Open VSX (Cursor)](#parte-2--publicar-no-open-vsx-prioridade--é-o-que-o-cursor-usa)
- [Parte 3 — Publicar no Visual Studio Marketplace (VS Code)](#parte-3--publicar-no-visual-studio-marketplace-vs-code)
- [Parte 4 — Atualizações futuras](#parte-4--atualizações-futuras-versionamento)
- [Checklist antes do primeiro publish](#checklist-antes-do-primeiro-publish)
- [Fontes](#fontes)

---

## Parte 0 — Contas necessárias

| Registry | Para quem | Contas necessárias |
|---|---|---|
| **Open VSX** (Cursor, VSCodium) | Usuários do Cursor | **Conta GitHub** + **conta Eclipse Foundation** (com o mesmo username do GitHub) + assinar o *Open VSX Publisher Agreement* |
| **Visual Studio Marketplace** (VS Code) | Usuários do VS Code | **Conta Microsoft** + uma **organização no Azure DevOps** (grátis, só para gerar o token) + um **publisher** no portal do Marketplace |

---

## Parte 1 — Preparar a extensão (ajustes obrigatórios)

A extensão tem **3 bloqueios** para publicar. Precisam ser corrigidos no `package.json`:

1. **`publisher` está como `"local"`** → trocar por um **ID real** (ex.: `TatiFKNavarro`).
   Esse mesmo ID será o *publisher* da Tati no VS Marketplace e o *namespace* dela no Open VSX.
2. **Falta o campo `repository`** → o `vsce` reclama e é exigido para boas práticas/verificação:
   ```json
   "repository": { "type": "git", "url": "https://github.com/TatiFKNavarro/simple-cursor-usage.git" }
   ```
3. **Falta um `icon`** → PNG **≥ 128×128** (SVG é proibido). Ex.: criar `images/icon.png` e referenciar:
   ```json
   "icon": "images/icon.png"
   ```

Já está OK: `README.md`, `LICENSE` (MIT), `CHANGELOG.md`, `engines.vscode`,
`categories`, `displayName`, `description`, versão `0.2.0`, e o `.vscodeignore`
já inclui o wasm do `sql.js` no pacote.

> ⚠️ **Marca "Cursor":** como é extensão não-oficial, mantenha o aviso
> "unofficial / not affiliated with Cursor" no README (já existe). Ambos os
> registries têm regras contra se passar por produto oficial.

**Compilar e empacotar para testar o pacote final:**

```bash
npm install -g @vscode/vsce
npm run compile
vsce package        # gera cursor-usage-for-teams-0.2.0.vsix
```

Instale o `.vsix` localmente (no Cursor: *Extensions: Install from VSIX…*) e confirme que funciona.

---

## Parte 2 — Publicar no **Open VSX** (prioridade — é o que o Cursor usa)

1. **Instale o CLI:**
   ```bash
   npm install -g ovsx     # ou use "npx ovsx ..."
   ```
2. **Crie a conta Eclipse** em <https://accounts.eclipse.org/user/register> — preencha
   **exatamente o username do GitHub da Tati (`TatiFKNavarro`)** no campo indicado.
3. **Assine o Publisher Agreement:** a Tati entra em <https://open-vsx.org> logando com o
   **GitHub** dela → avatar → **Settings** → **Log in with Eclipse** (autoriza) →
   **Show Publisher Agreement** → **Agree**.
4. **Gere um token de acesso** em <https://open-vsx.org/user-settings/tokens> →
   **Generate New Token** → copie e guarde (o valor **não é exibido de novo**).
5. **Crie o namespace** (= o `publisher`):
   ```bash
   npx ovsx create-namespace TatiFKNavarro -p <SEU_TOKEN>
   ```
6. **Publique:**
   ```bash
   npx ovsx publish -p <SEU_TOKEN>
   # ou, a partir do .vsix já gerado:
   npx ovsx publish cursor-usage-for-teams-0.2.0.vsix -p <SEU_TOKEN>
   ```

> O namespace começa **não verificado** (aparece um aviso de "unverified"). Para
> verificar a posse há um processo à parte (Namespace Access / claim) — opcional
> e pode ser feito depois.

---

## Parte 3 — Publicar no **Visual Studio Marketplace** (VS Code)

1. **Crie/entre numa organização do Azure DevOps** (<https://dev.azure.com>) com a sua conta Microsoft.
2. **Gere um Personal Access Token (PAT):** no Azure DevOps → **User settings**
   (canto superior) → **Personal access tokens** → **New Token**:
   - **Organization:** selecione **"All accessible organizations"** (se escolher
     uma específica, dá erro 401/403).
   - **Scopes:** *Custom defined* → *Show all scopes* → **Marketplace → Manage**.
   - Defina expiração → **Create** → **copie o token**.
3. **Crie o publisher** em <https://marketplace.visualstudio.com/manage> →
   **Create publisher** → defina **ID** (imutável, ex.: `TatiFKNavarro`) e **Name**.
4. **Faça login no vsce e publique:**
   ```bash
   vsce login TatiFKNavarro       # cole o PAT quando pedir
   vsce publish                   # publica a versão atual
   ```
   Alternativa sem CLI: `vsce package` e suba o `.vsix` manualmente no portal `/manage`.

> ⚠️ **Mudança importante (doc oficial):** os **PATs globais do Azure DevOps serão
> descontinuados em 1º de dezembro de 2026**. Para o primeiro publish manual em
> junho/2026 o PAT ainda funciona normalmente. Para automação futura (CI), a
> Microsoft recomenda migrar para **Microsoft Entra ID / managed identity**
> (`vsce publish --azure-credential`).

---

## Parte 4 — Atualizações futuras (versionamento)

```bash
# sobe a versão, cria commit+tag e publica no VS Marketplace:
vsce publish minor        # 0.2.0 -> 0.3.0  (ou: patch / 1.2.3)

# repetir no Open VSX:
npx ovsx publish -p <SEU_TOKEN>
```

Mantenha o `CHANGELOG.md` atualizado a cada release.

**Dica de automação (opcional):** a GitHub Action `HaaLeo/publish-vscode-extension`
publica **nos dois registries** de uma vez no CI — ótimo para manter VS Marketplace
e Open VSX em sincronia.

**Verified publisher (VS Marketplace, opcional/futuro):** exige extensão publicada
há ≥ 6 meses **e** domínio registrado há ≥ 6 meses, com verificação por registro DNS TXT.

---

## Checklist antes do primeiro publish

- [ ] `publisher` real (não `"local"`) — decidir o ID da Tati (sugestão: `TatiFKNavarro`).
- [ ] Campo `repository` no `package.json`.
- [ ] `icon` PNG ≥ 128×128 em `images/icon.png`.
- [ ] `npm run compile` sem erros e `vsce package` gerando o `.vsix`.
- [ ] `.vsix` instalado e testado localmente no Cursor.
- [ ] Open VSX: conta Eclipse + Publisher Agreement + token + namespace criado.
- [ ] VS Marketplace: publisher criado + PAT com escopo *Marketplace → Manage*.

---

## Fontes

- [VS Code — Publishing Extensions (doc oficial)](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Open VSX — Publishing Extensions (wiki oficial)](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)
- [Open VSX Registry (open-vsx.org)](https://open-vsx.org)
- [Migrating VS Code Extensions to Cursor (2026)](https://thinkpeak.ai/migrating-vs-code-extensions-to-cursor-2026/)
- [How to Import and Manage Extensions in Cursor (2026)](https://www.rapidevelopers.com/blog/how-to-import-and-manage-extensions-in-cursor-2026)
- [Publicando extensão no open-vsx.org para forks do VSCode (Cursor, VSCodium) — fórum ST](https://community.st.com/t5/stm32cubeide-for-visual-studio/publishing-stm32-extension-to-open-vsx-org-for-support-for/td-p/832071)
