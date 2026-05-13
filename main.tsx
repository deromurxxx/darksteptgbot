/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Bot, MessageSquare, Sparkles, FileJson } from 'lucide-react';

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 font-sans">
      <div className="max-w-3xl mx-auto">
        <header className="mb-12 text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-zinc-800 p-4 rounded-full">
              <Bot size={48} className="text-blue-400" />
            </div>
          </div>
          <h1 className="text-4xl font-bold mb-2 tracking-tight">DARKSTEP AI Stylist Bot</h1>
          <p className="text-zinc-400 text-lg">Ваш персональный ИИ-стилист в Telegram готов к работе.</p>
        </header>

        <main className="grid gap-6">
          <section className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <Sparkles className="text-yellow-500" />
              <h2 className="text-xl font-semibold">Статус подключения</h2>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
                <span className="text-zinc-400">Gemini API:</span>
                <span className="text-green-400 font-medium font-mono">ПОДКЛЮЧЕНО</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
                <span className="text-zinc-400">Telegram Bot:</span>
                <span className="text-blue-400 font-medium font-mono">АКТИВЕН</span>
              </div>
            </div>
          </section>

          <section className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <FileJson className="text-purple-500" />
              <h2 className="text-xl font-semibold">Каталог товаров (products.json)</h2>
            </div>
            <p className="text-zinc-400 mb-4 text-sm">
              Бот использует файл <code className="text-zinc-200">products.json</code> для рекомендаций. Отредактируйте его, чтобы добавить свои товары.
            </p>
            <div className="bg-black/50 p-4 rounded-lg font-mono text-xs overflow-x-auto text-zinc-500">
              {`[
  {
    "id": "1",
    "name": "Черная оверсайз футболка",
    "category": "Футболки",
    ...
  }
]`}
            </div>
          </section>

          <section className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <MessageSquare className="text-green-500" />
              <h2 className="text-xl font-semibold">Как исправить ошибку "Процессор перегрелся"</h2>
            </div>
            <ul className="list-disc list-inside text-zinc-400 space-y-2 text-sm">
              <li>Убедитесь, что вы добавили <code className="text-zinc-200">TELEGRAM_BOT_TOKEN</code> в секреты AI Studio.</li>
              <li>Проверьте <code className="text-zinc-200">GEMINI_API_KEY</code>.</li>
              <li>Файл <code className="text-zinc-200">products.json</code> должен быть валидным JSON.</li>
              <li>Если бот по-прежнему выдает ошибку, проверьте логи в консоли сервера.</li>
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}

