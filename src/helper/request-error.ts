import axios from 'axios'
import { showNotification } from './notification'

export const getRequestErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message || error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export const notifyRequestError = (error: unknown, key?: string) => {
  const message = getRequestErrorMessage(error)
  const url = axios.isAxiosError(error) ? decodeURIComponent(error.config?.url || '') : ''

  showNotification({
    key: key || message,
    content: url ? `${url} \n${message}` : message,
    type: 'alert-error',
  })
}
