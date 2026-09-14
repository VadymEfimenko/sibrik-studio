import { FlaskConical, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
export function AboutDialog({
  open,
  onClose,
  mode,
  providerName,
}: {
  open: boolean;
  onClose: () => void;
  mode: string | undefined;
  providerName: string | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="info-dialog"
      onCancel={() => onClose()}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <button className="dialog-close" onClick={() => onClose()} aria-label="Закрити">
        <X size={20} />
      </button>
      <div className="dialog-icon">
        <FlaskConical size={24} />
      </div>
      <h2>
        {mode && mode !== 'mock' ? `Студію підключено до ${providerName}` : 'Студія в демо-режимі'}
      </h2>
      <p>
        {mode && mode !== 'mock'
          ? 'Запуск створює реальне платне завдання у провайдера. Внутрішні кредити студії обліковуються окремо від його вартості в доларах.'
          : 'Можна пройти весь шлях: запустити завдання, побачити резерв, отримати тестовий ролик і повернення залишку. Реальні API-запити та витрати вимкнено.'}
      </p>
      <p>
        Тариф залежить від якості та зберігається на момент запуску. Референс-відео тарифікуються
        разом із результатом за виміряною тривалістю. Для заданої тривалості резерв включає 1 с
        запасу. Якщо фактична вартість перевищує резерв, різницю покриває студія.
      </p>
      <button className="generate" onClick={() => onClose()}>
        Зрозуміло
      </button>
    </dialog>
  );
}
