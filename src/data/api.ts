import { type UseQueryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/ui';
import { getBackend } from './backend';

export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const backend = await getBackend();
  return backend.rpc<T>(fn, args);
}

/** 讀取型 RPC；query key 為 [函式名稱, 參數] */
export function useRpc<T>(
  fn: string,
  args: Record<string, unknown> = {},
  options: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery<T, Error>({
    queryKey: [fn, args],
    queryFn: () => rpc<T>(fn, args),
    ...options,
  });
}

/**
 * 寫入型操作；結束後重新整理所有資料（資料量小，簡單可靠）。
 * 失敗時也重新整理：例如一次上傳多張照片，前幾張已經存進去，畫面要看得到。
 * 失敗訊息統一在這裡用提示顯示，呼叫端只需要處理成功之後要做的事。
 */
export function useAction<TArgs, TResult = unknown>(action: (args: TArgs) => Promise<TResult>) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation<TResult, Error, TArgs>({
    mutationFn: action,
    onError: (e) => toast(e.message, 'danger'),
    onSettled: () => client.invalidateQueries(),
  });
}
