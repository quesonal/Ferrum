import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { openFileGuard, openImageGuard } from './guards';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'library',
    component: () => import('../views/LibraryView.vue'),
  },
  {
    path: '/image/:id',
    name: 'image',
    component: () => import('../views/ImageView.vue'),
    props: true,
    beforeEnter: openImageGuard,
  },
  {
    path: '/open',
    name: 'open',
    component: () => import('../views/ImageView.vue'),
    props: (route) => ({ openPath: route.query.path as string }),
    beforeEnter: openFileGuard,
  },
  {
    // Catch-all redirect to library
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
