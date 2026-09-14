export const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 });
export const credits = (milli: number) => number.format(milli / 1000);
export const date = (value: string) =>
  new Date(value).toLocaleString('uk-UA', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
