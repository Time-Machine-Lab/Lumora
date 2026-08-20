import { useState } from 'react';
import type { PanelContextProps } from '@lumora/plugin-sdk';

/** 演示 aiProvider 贡献项：经 services.ai.chat 流式对话 */
export function MockAiChatPanel({ services }: PanelContextProps) {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    setOutput('');
    try {
      for await (const chunk of services.ai.chat('com.lumora.mock.ai', {
        model: 'mock-1',
        messages: [{ role: 'user', content }],
      })) {
        setOutput((current) => current + chunk);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lumora-mock-ai" data-testid="mock-ai-panel">
      <h4>Mock AI 助手（模型 mock-1）</h4>
      <div className="lumora-mock-chat">
        <input
          data-testid="mock-ai-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send();
          }}
          placeholder="输入消息，回车发送"
          disabled={busy}
        />
        <button type="button" data-testid="mock-ai-send" onClick={() => void send()} disabled={busy}>
          发送
        </button>
      </div>
      <p className="lumora-mock-result" data-testid="mock-ai-output">
        {output || '（回复将逐字流式显示）'}
      </p>
    </section>
  );
}
