import type { FeedbackPage, FeedbackStatus, FeedbackType } from '../types/image';
import { requestJson, requestJsonWithRetry } from './http';

export const feedbackApi = {
  feedbacks(query: { page?: number; pageSize?: number; status?: FeedbackStatus | null } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    return requestJsonWithRetry<FeedbackPage>(`/api/feedbacks${params.toString() ? `?${params}` : ''}`);
  },
  submitFeedback(payload: { title: string; type: FeedbackType; description: string; images: File[] }) {
    const body = new FormData();
    body.append('title', payload.title);
    body.append('type', payload.type);
    body.append('description', payload.description);
    payload.images.forEach(image => body.append('images', image, image.name));
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>('/api/feedbacks', {
      method: 'POST',
      body
    });
  },
  replyFeedback(id: string, payload: { status: FeedbackStatus; reply: string }) {
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>(`/api/feedbacks/${encodeURIComponent(id)}/reply`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  replyFeedbackMessage(id: string, content: string) {
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>(`/api/feedbacks/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  },
  setFeedbackStatus(id: string, status: FeedbackStatus) {
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>(`/api/feedbacks/${encodeURIComponent(id)}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
  },
};
