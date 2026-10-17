const toast = document.querySelector('#toast');
let toastTimer;
function notify(message) {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.className = 'sr-only';
  input.setAttribute('readonly', '');
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard unavailable');
}
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await copyText(button.dataset.copy);
      button.classList.add('copied');
      notify('已复制，粘贴到终端即可。');
      setTimeout(() => button.classList.remove('copied'), 2200);
    } catch {
      notify('浏览器无法访问剪贴板，请选中命令后手动复制。');
    }
  });
}

const terminal = document.querySelector('.terminal');
if (terminal) {
  const scenarios = {
    files: {
      prompt: '找出当前目录最大的五个文件',
      explanation: '只读取文件信息，按文件大小倒序排列。',
      command: 'find . -type f -exec du -k {} + \\\n  | sort -rn | head -n 5',
      output: '2456  ./assets/demo.mp4\n 892  ./public/preview.png\n 416  ./data/example.json\n 128  ./package-lock.json\n  24  ./README.md',
      conclusion: '已列出最大的五个文件，原文件未修改。',
    },
    project: {
      prompt: '帮我看看这个项目的文件结构',
      explanation: '列出两层目录中的文件，跳过 .git 目录。',
      command: 'find . -maxdepth 2 -type f \\\n  -not -path "./.git/*" | sort',
      output: './README.md\n./package.json\n./src/index.ts\n./src/config.ts\n./test/core.test.ts',
      conclusion: '示例项目包含入口、配置模块和测试。',
    },
    git: {
      prompt: '看看工作区有哪些改动，还不要提交',
      explanation: '查看工作区状态与 diff 统计，不创建提交。',
      command: 'git status --short && git diff --stat',
      output: ' M README.md\n M src/index.ts\n\n2 files changed, 18 insertions(+), 4 deletions(-)',
      conclusion: '已查看示例改动，未暂存文件或创建提交。',
    },
  };
  const $ = (selector) => terminal.querySelector(selector);
  const tabs = [...terminal.querySelectorAll('[data-scenario]')];
  const prompt = $('#demo-prompt');
  const status = $('#demo-status');
  const explanation = $('#demo-explanation');
  const command = $('#demo-command');
  const editor = $('#command-editor');
  const editorNote = $('#editor-note');
  const actions = $('#approval-actions');
  const approve = $('#approve-demo');
  const reject = $('#reject-demo');
  const edit = $('#edit-demo');
  const result = $('#demo-result');
  const ended = $('#demo-ended');
  const hint = $('#terminal-hint');
  let current = 'files';
  let editing = false;
  let finished = false;
  let draft = scenarios[current].command;
  function showCommand(value) {
    const code = document.createElement('code');
    const tokens = value.split(/\b(find|sort|head|git)\b/g);
    tokens.forEach((token, index) => {
      if (index % 2) {
        const span = document.createElement('span');
        span.className = 'syntax-command';
        span.textContent = token;
        code.append(span);
      } else code.append(document.createTextNode(token));
    });
    command.replaceChildren(code);
  }
  function reset(key = current) {
    current = key;
    editing = false;
    finished = false;
    const scenario = scenarios[current];
    draft = scenario.command;
    prompt.textContent = scenario.prompt;
    explanation.textContent = scenario.explanation;
    status.textContent = '等待你的审批';
    showCommand(draft);
    command.hidden = false;
    editor.hidden = true;
    editorNote.hidden = true;
    actions.hidden = false;
    result.hidden = true;
    result.replaceChildren();
    ended.hidden = true;
    approve.innerHTML = '<span aria-hidden="true">✓</span> 批准执行 <kbd>y</kbd>';
    edit.innerHTML = '编辑 <kbd>e</kbd>';
    hint.textContent = '试着批准、拒绝，或编辑这条命令';
    tabs.forEach((tab) => {
      const selected = tab.dataset.scenario === current;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    $('#demo-panel').setAttribute('aria-labelledby', `scenario-${current}`);
  }
  function finish(approved) {
    if (finished) return;
    if (editing) {
      const value = editor.value.trim();
      if (!value) { notify('请输入命令，或取消编辑。'); editor.focus(); return; }
      draft = value;
      editing = false;
      showCommand(draft);
      command.hidden = false;
      editor.hidden = true;
      editorNote.hidden = true;
    }
    finished = true;
    actions.hidden = true;
    result.hidden = false;
    result.tabIndex = -1;
    ended.hidden = false;
    const heading = document.createElement('p');
    heading.className = approved ? 'result-success' : 'result-reject';
    if (approved) {
      status.textContent = '演示完成';
      const changed = draft !== scenarios[current].command;
      const output = document.createElement('pre');
      output.textContent = changed ? '已保存你的编辑内容。\n实际使用时，将执行你确认后的完整命令。' : scenarios[current].output;
      heading.textContent = changed ? '✓ 已演示编辑与批准流程' : '✓ ' + scenarios[current].conclusion;
      result.replaceChildren(output, heading);
    } else {
      status.textContent = '已拒绝';
      heading.textContent = '◇ 已拒绝，命令未执行。';
      result.replaceChildren(heading);
    }
    hint.textContent = '离线演示结束，未执行任何本机命令';
    result.focus({ preventScroll: true });
  }
  function toggleEdit() {
    if (finished) return;
    editing = !editing;
    if (editing) {
      editor.value = draft;
      editor.hidden = false;
      editorNote.hidden = false;
      command.hidden = true;
      status.textContent = '编辑命令';
      approve.textContent = '✓ 保存并演示';
      edit.textContent = '取消编辑';
      hint.textContent = '可直接修改命令 · Esc 放弃编辑';
      editor.focus({ preventScroll: true });
    } else {
      editor.hidden = true;
      editorNote.hidden = true;
      command.hidden = false;
      status.textContent = '等待你的审批';
      approve.innerHTML = '<span aria-hidden="true">✓</span> 批准执行 <kbd>y</kbd>';
      edit.innerHTML = '编辑 <kbd>e</kbd>';
      hint.textContent = '试着批准、拒绝，或编辑这条命令';
      edit.focus({ preventScroll: true });
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => reset(tab.dataset.scenario));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      reset(tabs[next].dataset.scenario);
      tabs[next].focus();
    });
  });
  approve.addEventListener('click', () => finish(true));
  reject.addEventListener('click', () => finish(false));
  edit.addEventListener('click', toggleEdit);
  $('#replay-demo').addEventListener('click', () => { reset(); approve.focus({ preventScroll: true }); });
  terminal.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target === editor) {
      if (event.key === 'Escape') { event.preventDefault(); toggleEdit(); }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'y') { event.preventDefault(); finish(true); }
    if (key === 'n') { event.preventDefault(); finish(false); }
    if (key === 'e') { event.preventDefault(); toggleEdit(); }
  });
  reset();
}
