import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import { naive } from './plugins/naive-ui';
import AppLayout from './layouts/AppLayout.vue';
import { clearCurrentUser, currentUser, defaultRouteForUser, setCurrentUser } from './composables/auth';
import { authApi } from './services/auth';
import { setUnauthorizedHandler } from './services/http';
import AdminLayout from './layouts/AdminLayout.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    {
      path: '/',
      component: AdminLayout,
      children: [
        { path: '', component: () => import('./views/RatingView.vue') },
        { path: 'tasks', redirect: '/' },
        { path: 'feedbacks', component: () => import('./views/FeedbackView.vue') }
      ]
    },
    {
      path: '/admin',
      component: AdminLayout,
      children: [
        { path: '', component: () => import('./views/AdminDashboardView.vue') },
        { path: 'packages', component: () => import('./views/AdminProjectView.vue') },
        { path: 'projects', component: () => import('./views/AdminProjectsView.vue') },
        { path: 'tasks', component: () => import('./views/AdminTaskManagerView.vue') },
        { path: 'scoring', component: () => import('./views/AdminScoringView.vue') },
        { path: 'accounts', component: () => import('./views/AdminAccountView.vue') },
        { path: 'teams', component: () => import('./views/AdminTeamsView.vue') },
        { path: 'feedbacks', component: () => import('./views/AdminFeedbackView.vue') },
        { path: 'projects/:subjectId/tasks', component: () => import('./views/AdminTaskView.vue'), alias: 'subjects/:subjectId/tasks' },
        { path: 'packages/:subjectId', component: () => import('./views/AdminSubjectView.vue'), alias: ['subjects/:subjectId', 'projects/:subjectId/images'] }
      ]
    }
  ]
});

setUnauthorizedHandler(async () => {
  const current = router.currentRoute.value;
  if (current.path === '/login') return;
  await router.replace({ path: '/login', query: { redirect: current.fullPath } });
});

router.beforeEach(to => {
  const user = currentUser.value;
  if (to.meta.public) {
    return user ? defaultRouteForUser(user) : true;
  }
  if (!user) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (user.role === 'admin' && !to.path.startsWith('/admin')) {
    return '/admin';
  }
  if (user.role !== 'admin' && to.path.startsWith('/admin')) {
    return '/';
  }
  return true;
});

async function bootstrap() {
  try {
    const { user } = await authApi.session();
    setCurrentUser(user);
    if (user.mustChangePassword) await router.replace(defaultRouteForUser(user));
  } catch {
    clearCurrentUser();
  }
  createApp(AppLayout).use(createPinia()).use(naive).use(router).mount('#app');
}

void bootstrap();
