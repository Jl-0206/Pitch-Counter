import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDEStB8CnEeUKyvXaXGgW3NIPmyvwPcfmI",
  authDomain: "pitch-counter-22f5e.firebaseapp.com",
  projectId: "pitch-counter-22f5e",
  storageBucket: "pitch-counter-22f5e.firebasestorage.app",
  messagingSenderId: "582181111343",
  appId: "1:582181111343:web:df7249e2a1be76282ae8da"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
