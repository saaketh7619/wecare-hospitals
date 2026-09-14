import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  User as FirebaseUser
} from 'firebase/auth';
import {
  initializeFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';
import { UserProfile } from './types/auth';
import { Appointment } from './types/hospital';
import firebaseAppletConfig from '../firebase-applet-config.json';

// Web app's Firebase configuration with fallback
export const firebaseConfig = {
  apiKey: "AIzaSyDSgxEesWZGWXxpkaEUuKUrQapS94L08ms",
  authDomain: "wecare-hospitals-9892d.firebaseapp.com",
  projectId: "wecare-hospitals-9892d",
  storageBucket: "wecare-hospitals-9892d.firebasestorage.app",
  messagingSenderId: "985673797728",
  appId: "1:985673797728:web:0c43ca2c753dc0f1b53305",
  firestoreDatabaseId: "ai-studio-wecarehospitals-c1363f61-4ee6-41bf-bb67-dd6c1bb5d841",
  ...firebaseAppletConfig,
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(
  app,
  {
    experimentalAutoDetectLongPolling: true,
  },
  firebaseConfig.firestoreDatabaseId || 'ai-studio-wecarehospitals-c1363f61-4ee6-41bf-bb67-dd6c1bb5d841'
);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });


// Standardized Operation types and error handler as per Firebase integration specifications
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Helper to strip undefined values because Firestore setDoc/addDoc rejects undefined fields
export function sanitizeForFirestore<T extends Record<string, any>>(data: T): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        clean[key] = sanitizeForFirestore(value);
      } else {
        clean[key] = value;
      }
    }
  }
  return clean;
}

// ==========================================
// User Profile Helpers
// ==========================================

export async function saveUserProfile(userProfile: UserProfile): Promise<void> {
  const path = `users/${userProfile.uid}`;
  try {
    const userDocRef = doc(db, 'users', userProfile.uid);
    const sanitized = sanitizeForFirestore(userProfile);
    await setDoc(userDocRef, sanitized, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const path = `users/${uid}`;
  try {
    const userDocRef = doc(db, 'users', uid);
    const snap = await getDoc(userDocRef);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }
    return null;
  } catch (error: any) {
    if (
      error?.code === 'unavailable' ||
      String(error?.message || '').includes('offline') ||
      String(error?.message || '').includes('unavailable')
    ) {
      console.warn('Firestore temporarily offline/unavailable while fetching profile:', error?.message);
      return null;
    }
    handleFirestoreError(error, OperationType.GET, path);
  }
}

// ==========================================
// Bookings Helpers
// ==========================================

export async function saveBookingToDb(booking: Appointment, userId: string): Promise<void> {
  const path = `bookings/${booking.id}`;
  try {
    const docRef = doc(db, 'bookings', booking.id);
    const dataToSave = sanitizeForFirestore({
      ...booking,
      userId,
      updatedAt: new Date().toISOString(),
    });
    await setDoc(docRef, dataToSave);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateBookingStatusInDb(bookingId: string, status: Appointment['status']): Promise<void> {
  const path = `bookings/${bookingId}`;
  try {
    const docRef = doc(db, 'bookings', bookingId);
    await updateDoc(docRef, sanitizeForFirestore({
      status,
      updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function rescheduleBookingInDb(bookingId: string, newDate: string, newSlot: string): Promise<void> {
  const path = `bookings/${bookingId}`;
  try {
    const docRef = doc(db, 'bookings', bookingId);
    await updateDoc(docRef, sanitizeForFirestore({
      appointmentDate: newDate,
      appointmentTime: newSlot,
      status: 'Rescheduled',
      updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeUserBookings(
  userId: string,
  onUpdate: (bookings: Appointment[]) => void,
  onError?: (err: Error) => void
): () => void {
  const path = 'bookings';
  try {
    const q = query(
      collection(db, 'bookings'),
      where('userId', '==', userId)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const bookingsList: Appointment[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as Appointment;
          bookingsList.push(data);
        });

        // Sort descending by appointment date or createdAt
        bookingsList.sort((a, b) => {
          const dateA = new Date(a.createdAt || a.appointmentDate).getTime();
          const dateB = new Date(b.createdAt || b.appointmentDate).getTime();
          return dateB - dateA;
        });

        onUpdate(bookingsList);
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, path);
        } catch (wrapped) {
          if (onError && wrapped instanceof Error) {
            onError(wrapped);
          }
        }
      }
    );

    return unsubscribe;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

// ==========================================
// Admin Bookings Helpers
// ==========================================

export function subscribeAllBookings(
  onUpdate: (bookings: Appointment[]) => void,
  onError?: (err: Error) => void
): () => void {
  const path = 'bookings';
  try {
    const q = query(collection(db, 'bookings'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const bookingsList: Appointment[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as Appointment;
          bookingsList.push(data);
        });

        // Sort descending by appointment date or createdAt
        bookingsList.sort((a, b) => {
          const dateA = new Date(a.createdAt || a.appointmentDate).getTime();
          const dateB = new Date(b.createdAt || b.appointmentDate).getTime();
          return dateB - dateA;
        });

        onUpdate(bookingsList);
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, path);
        } catch (wrapped) {
          if (onError && wrapped instanceof Error) {
            onError(wrapped);
          }
        }
      }
    );

    return unsubscribe;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function deleteBookingInDb(bookingId: string): Promise<void> {
  const path = `bookings/${bookingId}`;
  try {
    const docRef = doc(db, 'bookings', bookingId);
    await deleteDoc(docRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function updateBookingInDb(bookingId: string, updates: Partial<Appointment>): Promise<void> {
  const path = `bookings/${bookingId}`;
  try {
    const docRef = doc(db, 'bookings', bookingId);
    await updateDoc(docRef, sanitizeForFirestore({
      ...updates,
      updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function addAdminBookingToDb(booking: Appointment): Promise<void> {
  const path = `bookings/${booking.id}`;
  try {
    const docRef = doc(db, 'bookings', booking.id);
    const dataToSave = sanitizeForFirestore({
      ...booking,
      userId: booking.patientId || auth.currentUser?.uid || 'admin-created',
      createdByAdmin: true,
      updatedAt: new Date().toISOString(),
    });
    await setDoc(docRef, dataToSave);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

