import { initializeApp, getApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../firebase-applet-config.json' assert { type: 'json' };

const app = !getApps().length 
  ? initializeApp({
      projectId: firebaseConfig.projectId,
    })
  : getApp();

// Использование конкретного ID базы данных из конфига
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
