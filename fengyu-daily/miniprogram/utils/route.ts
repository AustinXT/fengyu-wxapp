import { showError } from './cloud';

export function decodeRouteId(value?: string): string | null {
  try {
    return decodeURIComponent(value || '');
  } catch (_) {
    showError(new Error('页面参数无效，请返回后重新进入'));
    return null;
  }
}
