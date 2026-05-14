import React, { useState, useEffect, useRef } from 'react';
import * as Icons from 'lucide-react';
import { 
  Search, 
  Globe, 
  MessageCircle, 
  Camera, 
  Image as ImageIcon, 
  Mic, 
  Phone, 
  ArrowLeft, 
  Send,
  Check,
  CheckCheck,
  MoreVertical,
  User,
  LogOut,
  Shield,
  MapPin,
  Clock,
  Instagram,
  Facebook,
  Mail
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { io, Socket } from 'socket.io-client';
import { SERVICES, LANGUAGES, ADMIN_PASSCODE, URGENT_NUMBERS, PRIMARY_CONTACT, BUSINESS_ADDRESS, TRANSLATIONS } from './constants';
import { getAiResponse } from './services/geminiService';

// --- Types ---
type Message = {
  id: number;
  customer_id: string;
  sender: 'user' | 'ai' | 'admin';
  content: string;
  type: 'text' | 'image' | 'audio';
  timestamp: string;
  seen: number;
  tempId?: string;
};

type Customer = {
  id: string;
  phone: string;
  address: string;
  name: string;
  last_active: string;
};

// --- Components ---

export default function App() {
  const [language, setLanguage] = useState(() => {
    try {
      return localStorage.getItem('language') || 'en';
    } catch (e) {
      console.error('LocalStorage not accessible:', e);
      return 'en';
    }
  });
  const [showLanguagePicker, setShowLanguagePicker] = useState(() => {
    try {
      return !localStorage.getItem('language');
    } catch (e) {
      return true;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<'home' | 'chat' | 'admin'>('home');

  const t = (key: string) => {
    return TRANSLATIONS[language]?.[key] || TRANSLATIONS['en'][key] || key;
  };

  const handleLanguageSelect = (lang: string) => {
    try {
      localStorage.setItem('language', lang);
    } catch (e) {
      console.warn('Could not save language to localStorage');
    }
    setLanguage(lang);
    setShowLanguagePicker(false);
  };
  const [selectedService, setSelectedService] = useState<typeof SERVICES[0] | null>(null);
  const [logoClicks, setLogoClicks] = useState(0);
  const [showPasscode, setShowPasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [customerId] = useState(() => {
    try {
      return localStorage.getItem('customerId') || Math.random().toString(36).substring(7);
    } catch (e) {
      return Math.random().toString(36).substring(7);
    }
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedAdminCustomer, setSelectedAdminCustomer] = useState<Customer | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [unseenCounts, setUnseenCounts] = useState<Record<string, number>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const selectedAdminCustomerRef = useRef<Customer | null>(null);
  const viewRef = useRef<string>(view);

  useEffect(() => {
    selectedAdminCustomerRef.current = selectedAdminCustomer;
  }, [selectedAdminCustomer]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    console.log("App component mounted. Customer ID:", customerId);
  }, []);

  useEffect(() => {
    // Current counts
    const updateCounts = async () => {
      const newCounts: Record<string, number> = {};
      for (const c of customers) {
        try {
          const res = await fetch(`/api/admin/messages/${c.id}`);
          if (res.ok) {
            const msgs = await res.json();
            newCounts[c.id] = msgs.filter((m: any) => m.sender !== 'admin' && !m.seen).length;
          }
        } catch (e) {
          console.error("Error fetching admin counts:", e);
        }
      }
      setUnseenCounts(newCounts);
    };
    if (view === 'admin') {
      updateCounts();
    }
  }, [customers, messages, view]);

  useEffect(() => {
    if (view === 'admin' && socket && isConnected) {
      console.log("Emitting joinAdmin");
      socket.emit('joinAdmin');
    }
    if (view === 'chat' && customerId) {
      fetchMessages(customerId);
    }
  }, [view, socket, isConnected, customerId]);

  useEffect(() => {
    try {
      localStorage.setItem('customerId', customerId);
    } catch (e) {
      console.warn('Could not save customerId to localStorage');
    }
    console.log("Initializing socket...");
    const newSocket = io({
      reconnectionAttempts: 10,
      timeout: 10000,
      transports: ['websocket', 'polling'],
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log("Socket connected! ID:", newSocket.id);
      setIsConnected(true);
      setSocketError(null);
      newSocket.emit('join', customerId);
      fetchCustomers();
    });

    newSocket.on('reconnect', (attempt) => {
      console.log("Socket reconnected on attempt:", attempt);
      setIsConnected(true);
      setSocketError(null);
    });

    newSocket.on('reconnect_attempt', (attempt) => {
      console.log(`Socket attempting to reconnect... (Attempt ${attempt})`);
      setSocketError(`Connecting... (Attempt ${attempt})`);
    });

    newSocket.on('disconnect', (reason) => {
      console.log("Socket disconnected. Reason:", reason);
      setIsConnected(false);
      setSocketError(`Disconnected: ${reason}`);
      if (reason === 'io server disconnect' || reason === 'transport close') {
        newSocket.connect();
      }
    });

    newSocket.on('connect_error', (err) => {
      console.error("Socket Connection Error:", err.message);
      setIsConnected(false);
      setSocketError(`Connection Error: ${err.message}`);
    });

    newSocket.on('message', (msg: Message & { tempId?: string }) => {
      console.log("Received 'message' event:", msg);
      if (msg.customer_id === customerId) {
        setMessages(prev => {
          // Remove optimistic message that matches the incoming one by tempId or content
          const filtered = prev.filter(m => {
            if (m.id > 0) return true; // Keep permanent messages
            if (msg.tempId && m.tempId === msg.tempId) return false;
            // Fallback for older messages or different flow
            return m.content !== msg.content || m.sender !== msg.sender;
          });
          // Prevent duplicates
          if (filtered.some(m => m.id === msg.id)) return filtered;
          return [...filtered, msg];
        });
      }
    });

    newSocket.on('admin:new_message', (msg: Message & { tempId?: string }) => {
      console.log("Received 'admin:new_message' event:", msg);
      if (viewRef.current === 'admin') {
        fetchCustomers();
        if (selectedAdminCustomerRef.current?.id === msg.customer_id) {
          setMessages(prev => {
            // Remove optimistic message that matches the incoming one
            const filtered = prev.filter(m => {
              if (m.id > 0) return true;
              if (msg.tempId && m.tempId === msg.tempId) return false;
              return m.content !== msg.content || m.sender !== msg.sender;
            });
            if (filtered.some(m => m.id === msg.id)) return filtered;
            return [...filtered, msg];
          });
        }
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, [customerId]);

  const fetchCustomers = async () => {
    const res = await fetch('/api/admin/customers');
    const data = await res.json();
    setCustomers(data);
  };

  const fetchMessages = async (id: string) => {
    const res = await fetch(`/api/admin/messages/${id}`);
    const data = await res.json();
    setMessages(data);
  };

  const handleLogoClick = () => {
    setLogoClicks(prev => {
      if (prev + 1 >= 7) {
        setShowPasscode(true);
        return 0;
      }
      return prev + 1;
    });
    setTimeout(() => setLogoClicks(0), 3000); // Reset clicks after 3s
  };

  const handlePasscodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (passcode === ADMIN_PASSCODE) {
      setView('admin');
      setShowPasscode(false);
      setPasscode('');
      fetchCustomers();
    } else {
      alert('Incorrect Passcode');
      setPasscode('');
    }
  };

  const sendMessage = async (content: string, type: 'text' | 'image' | 'audio' = 'text', sender: 'user' | 'ai' | 'admin' = 'user') => {
    console.log(`sendMessage called: sender=${sender}, type=${type}, contentLen=${content.length}`);
    if (!socket) {
      console.warn("sendMessage: No socket available");
      return;
    }

    if (!content.trim() && type === 'text') return;

    const targetCustomerId = sender === 'admin' ? selectedAdminCustomer?.id : customerId;
    if (!targetCustomerId) return;

    const msgData = {
      customerId: targetCustomerId,
      sender,
      content,
      type
    };

    // Optimistic Update for UI
    const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const optimisticMsg: Message = {
      id: -1, // Use -1 for all optimistic messages
      customer_id: targetCustomerId,
      sender,
      content,
      type,
      timestamp: new Date().toISOString(),
      seen: 0,
      tempId
    };

    if (sender === 'user' || sender === 'admin') {
      setMessages(prev => [...prev, optimisticMsg]);
    }

    setIsSending(true);

    try {
      if (sender === 'admin') {
        const res = await fetch('/api/admin/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...msgData, tempId })
        });
        if (res.ok) {
           // Success - server will emit admin:new_message which we catch
        }
      } else {
        if (!socket.connected) {
          console.warn("Socket not connected, trying to reconnect...");
          socket.connect();
        }
        
        socket.emit('sendMessage', { ...msgData, tempId });

        // If user sent a message, trigger AI response
        if (sender === 'user') {
          const hasPhoto = messages.some(m => m.type === 'image') || type === 'image';
          const promptText = type === 'audio' ? "I have sent a voice message describing my problem." : content;
          
          // Don't await AI response before finishing user send
          getAiResponse(promptText, language, hasPhoto).then((aiResponse) => {
            sendMessage(aiResponse, 'text', 'ai');
          }).catch(err => {
            console.error("AI Response error:", err);
          });
        }
      }
    } catch (err) {
      console.error("Error sending message:", err);
    } finally {
      setIsSending(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        sendMessage(reader.result as string, 'image');
      };
      reader.readAsDataURL(file);
    }
  };

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Media devices not supported');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : '';

      mediaRecorder.current = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks.current = [];
      
      mediaRecorder.current.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.current.push(e.data);
        }
      };
      
      mediaRecorder.current.onstop = () => {
        const audioBlob = new Blob(audioChunks.current, { type: mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          sendMessage(reader.result as string, 'audio');
        };
        reader.readAsDataURL(audioBlob);
        
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorder.current.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Error starting recording:', err);
      alert('Could not start recording. Please ensure microphone access is granted.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && mediaRecorder.current.state === 'recording') {
      mediaRecorder.current.stop();
    }
    setIsRecording(false);
  };

  const filteredServices = SERVICES.filter(s => {
    const name = (s.name as any)[language] || (s.name as any)['en'];
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const [showRegistration, setShowRegistration] = useState(false);
  const [regData, setRegData] = useState({ phone: '', address: '', name: '' });

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: customerId, ...regData })
    });
    setShowRegistration(false);
    setView('chat');
    if (messages.length === 0 && selectedService) {
      // Send initial welcome from AI
      const welcomeMsg = t('welcome');
      
      socket?.emit('sendMessage', {
        customerId,
        sender: 'ai',
        content: welcomeMsg,
        type: 'text'
      });
    }
  };

  return (
    <div className="min-h-screen bg-[#F0F2F5] font-sans text-slate-900">
      {/* --- Initial Language Picker --- */}
      <AnimatePresence>
        {showLanguagePicker && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-white"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-full max-w-md p-8 text-center"
            >
              <div className="flex items-center justify-center w-20 h-20 mx-auto mb-8 text-white shadow-2xl bg-gradient-to-br from-emerald-500 to-teal-600 rounded-3xl">
                <Shield size={40} />
              </div>
              <h1 className="mb-2 text-3xl font-black tracking-tight text-emerald-900">BHAVANA</h1>
              <p className="mb-8 text-xs font-bold tracking-[0.3em] text-slate-400 uppercase">Multiservices</p>
              
              <h2 className="mb-6 text-xl font-bold text-slate-800">Select Your Language</h2>
              <div className="grid gap-4">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => handleLanguageSelect(lang.code)}
                    className="flex items-center justify-between p-5 transition-all bg-slate-50 border-2 border-slate-100 rounded-2xl hover:border-emerald-500 hover:bg-emerald-50 group"
                  >
                    <span className="text-lg font-bold text-slate-700 group-hover:text-emerald-700">{lang.name}</span>
                    <Globe size={20} className="text-slate-300 group-hover:text-emerald-500" />
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* --- Registration Modal --- */}
      <AnimatePresence>
        {showRegistration && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md p-8 bg-white shadow-2xl rounded-3xl"
            >
              <h2 className="mb-2 text-2xl font-black text-center text-emerald-900">{t('getStarted')}</h2>
              <p className="mb-6 text-center text-slate-500 text-sm">{t('aboutUs').substring(0, 60)}...</p>
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase mb-1 ml-1 tracking-widest">{t('yourName')}</label>
                  <input 
                    type="text" 
                    required
                    value={regData.name}
                    onChange={(e) => setRegData({ ...regData, name: e.target.value })}
                    placeholder="e.g. Rahul Sharma"
                    className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-emerald-500 focus:outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase mb-1 ml-1 tracking-widest">{t('contactNumber')}</label>
                  <input 
                    type="tel" 
                    required
                    value={regData.phone}
                    onChange={(e) => setRegData({ ...regData, phone: e.target.value })}
                    placeholder="e.g. +91 98813 45984"
                    className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-emerald-500 focus:outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase mb-1 ml-1 tracking-widest">{t('serviceAddress')}</label>
                  <textarea 
                    required
                    value={regData.address}
                    onChange={(e) => setRegData({ ...regData, address: e.target.value })}
                    placeholder="Enter your full address for technician visit"
                    className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-emerald-500 focus:outline-none h-24 resize-none transition-all"
                  />
                </div>
                <button 
                  type="submit"
                  className="w-full p-4 font-bold text-white bg-emerald-600 rounded-2xl hover:bg-emerald-700 shadow-xl shadow-emerald-200 transition-all active:scale-95"
                >
                  {t('connectExperts')}
                </button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* --- Passcode Modal --- */}
      <AnimatePresence>
        {showPasscode && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md p-8 bg-white shadow-2xl rounded-3xl"
            >
              <h2 className="mb-6 text-2xl font-bold text-center">Admin Access</h2>
              <form onSubmit={handlePasscodeSubmit}>
                <input 
                  type="password" 
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Enter Passcode"
                  className="w-full p-4 mb-4 text-center text-2xl tracking-widest border-2 border-slate-200 rounded-2xl focus:border-emerald-500 focus:outline-none"
                  autoFocus
                />
                <div className="flex gap-4">
                  <button 
                    type="button"
                    onClick={() => setShowPasscode(false)}
                    className="flex-1 p-4 font-semibold text-slate-500 bg-slate-100 rounded-2xl hover:bg-slate-200"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 p-4 font-semibold text-white bg-emerald-600 rounded-2xl hover:bg-emerald-700"
                  >
                    Enter
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Home View --- */}
      {view === 'home' && (
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <header className="sticky top-0 z-30 p-6 bg-white/80 backdrop-blur-md">
            <div className="flex items-center justify-between mb-6 flex-row-reverse">
              <div className="flex items-center gap-3 flex-row-reverse">
                <div 
                  onClick={handleLogoClick}
                  className="flex items-center justify-center w-12 h-12 text-white shadow-lg cursor-pointer bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl"
                >
                  <Shield size={28} />
                </div>
                <div className="text-right">
                  <h1 className="text-xl font-black tracking-tight text-emerald-800">BHAVANA</h1>
                  <p className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">Multiservices</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className={`p-1 px-2 rounded-full text-[10px] font-bold flex items-center gap-1 ${isConnected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                  {isConnected ? t('online') : (socketError || 'Offline')}
                  {!isConnected && (
                    <button 
                      onClick={() => socket?.connect()}
                      className="ml-1 underline"
                    >
                      Retry
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 p-2 bg-slate-100 rounded-xl">
                  <Globe size={18} className="text-slate-500" />
                  <select 
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="text-sm font-semibold bg-transparent focus:outline-none"
                  >
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute text-slate-400 left-4 top-1/2 -translate-y-1/2" size={20} />
              <input 
                type="text"
                placeholder={t('search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full p-4 pl-12 bg-slate-100 border-none rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>
          </header>

          {/* Services Grid */}
          <main className="p-6 grid grid-cols-2 gap-4">
            {filteredServices.map((service) => (
              <motion.div
                key={service.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setSelectedService(service);
                  // Check if registered
                  const isRegistered = customers.some(c => c.id === customerId);
                  if (!isRegistered) {
                    setShowRegistration(true);
                  } else {
                    setView('chat');
                    if (messages.length === 0) {
                      const welcomeMsg = t('welcome');
                      
                      socket?.emit('sendMessage', {
                        customerId,
                        sender: 'ai',
                        content: welcomeMsg,
                        type: 'text'
                      });
                    }
                  }
                }}
                className="overflow-hidden bg-white shadow-sm cursor-pointer rounded-3xl group"
              >
                <div className="relative aspect-[4/3] overflow-hidden">
                  <img 
                    src={service.image} 
                    alt={(service.name as any)[language]}
                    className="object-cover w-full h-full transition-transform duration-500 group-hover:scale-110"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  <div className="absolute bottom-3 left-3 flex items-center gap-2 text-white">
                    <div className="p-1.5 bg-white/20 backdrop-blur-md rounded-lg">
                      {React.createElement((Icons as any)[service.icon] || MessageCircle, { size: 16 })}
                    </div>
                  </div>
                </div>
                <div className="p-4">
                  <h3 className="font-bold text-slate-800">{(service.name as any)[language]}</h3>
                  <p className="text-xs text-slate-400">{t('tapToChat')}</p>
                </div>
              </motion.div>
            ))}
          </main>

          {/* Footer */}
          <footer className="mt-12 p-8 bg-white border-t border-slate-100">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex items-center justify-center w-10 h-10 text-white shadow-md bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl">
                    <Shield size={20} />
                  </div>
                  <h2 className="text-lg font-black tracking-tight text-emerald-800">BHAVANA MULTISERVICES</h2>
                </div>
                <p className="text-sm text-slate-500 mb-6 leading-relaxed">
                  {t('aboutUs')}
                </p>
                <div className="flex gap-4">
                  <a href="#" className="p-2 bg-slate-100 rounded-full text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 transition-colors">
                    <Facebook size={20} />
                  </a>
                  <a href="#" className="p-2 bg-slate-100 rounded-full text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 transition-colors">
                    <Instagram size={20} />
                  </a>
                  <a href="#" className="p-2 bg-slate-100 rounded-full text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 transition-colors">
                    <Mail size={20} />
                  </a>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-bold text-slate-800 mb-2">{t('contactInfo')}</h3>
                <div className="flex items-start gap-3">
                  <MapPin className="text-emerald-600 shrink-0 mt-1" size={18} />
                  <p className="text-sm text-slate-600">{BUSINESS_ADDRESS}</p>
                </div>
                <div className="flex items-start gap-3">
                  <Phone className="text-emerald-600 shrink-0 mt-1" size={18} />
                  <div className="text-sm text-slate-600 space-y-1">
                    <p><a href={`tel:${PRIMARY_CONTACT}`} className="hover:text-emerald-600">{PRIMARY_CONTACT}</a> (Primary)</p>
                    {URGENT_NUMBERS.map(n => (
                      <p key={n}><a href={`tel:${n}`} className="hover:text-emerald-600">{n}</a></p>
                    ))}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Clock className="text-emerald-600 shrink-0 mt-1" size={18} />
                  <p className="text-sm text-slate-600">
                    {t('monSat')}<br/>
                    <span className="font-bold text-emerald-700">{t('emergency247')}</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-8 border-t border-slate-100 text-center">
              <p className="text-xs text-slate-400 font-medium">
                © {new Date().getFullYear()} BHAVANA MULTISERVICES. {t('allRights')}
              </p>
              <p className="text-[10px] text-slate-300 mt-1">
                {t('designedFor')}
              </p>
            </div>
          </footer>
        </div>
      )}

      {/* --- Chat View --- */}
      {view === 'chat' && (
        <div className="flex flex-col h-screen max-w-4xl mx-auto bg-white shadow-xl">
          {/* Chat Header */}
          <header className="flex items-center justify-between p-4 bg-[#075E54] text-white">
            <div className="flex items-center gap-3">
              <button onClick={() => setView('home')} className="p-1 hover:bg-white/10 rounded-full">
                <ArrowLeft size={24} />
              </button>
              <div className="w-10 h-10 overflow-hidden bg-white rounded-full">
                <img src={selectedService?.image} alt="" className="object-cover w-full h-full" referrerPolicy="no-referrer" />
              </div>
              <div>
                <h2 className="font-bold leading-tight">{(selectedService?.name as any)?.[language]}</h2>
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                  <p className="text-[10px] opacity-80">{isConnected ? t('online') : (socketError || t('connecting'))}</p>
                  {!isConnected && (
                    <button 
                      onClick={() => socket?.connect()}
                      className="text-[10px] bg-white/20 px-2 py-0.5 rounded hover:bg-white/30 transition-colors"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Phone size={20} className="cursor-pointer" onClick={() => window.open(`tel:${PRIMARY_CONTACT}`)} />
              <MoreVertical size={20} />
            </div>
          </header>

          {/* Messages Area */}
          <div className="flex-1 p-4 overflow-y-auto bg-[#E5DDD5] whatsapp-bg space-y-3">
            <div className="flex justify-center mb-4">
              <span className="px-3 py-1 text-[10px] font-bold text-slate-500 bg-white/60 rounded-lg uppercase tracking-wider">
                Today
              </span>
            </div>
            
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[80%] p-3 rounded-2xl shadow-sm relative ${
                  msg.id < 0 ? 'opacity-70' : ''
                } ${
                  msg.sender === 'user' 
                    ? 'bg-[#DCF8C6] rounded-tr-none' 
                    : 'bg-white rounded-tl-none'
                }`}>
                  {msg.type === 'text' && <p className="text-sm text-slate-800">{msg.content}</p>}
                  {msg.type === 'image' && (
                    <img src={msg.content} alt="Sent" className="max-w-full rounded-lg" />
                  )}
                  {msg.type === 'audio' && (
                    <audio controls src={msg.content} className="max-w-full h-8" />
                  )}
                  <div className="flex items-center justify-end gap-1 mt-1">
                    <span className="text-[9px] text-slate-400">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {msg.sender === 'user' && (
                      msg.id < 0 ? <Clock size={10} className="text-slate-400 animate-pulse" /> :
                      msg.seen ? <CheckCheck size={12} className="text-blue-500" /> : <Check size={12} className="text-slate-400" />
                    )}
                  </div>
                </div>
              </div>
            ))}
            {isSending && (
              <div className="flex justify-end">
                <div className="bg-[#DCF8C6] rounded-2xl rounded-tr-none p-2 px-4 shadow-sm animate-pulse flex items-center gap-2">
                  <div className="flex gap-1">
                    <div className="w-1 h-1 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1 h-1 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1 h-1 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Sending</span>
                </div>
              </div>
            )}
          </div>

          {/* Urgent Numbers Banner */}
          <div className="p-2 text-center bg-emerald-50 border-y border-emerald-100">
            <p className="text-[10px] text-emerald-700 font-medium">
              {t('urgentCall')} {URGENT_NUMBERS.map((n, i) => (
                <span key={n}>
                  <a href={`tel:${n}`} className="font-bold underline">{n}</a>
                  {i < URGENT_NUMBERS.length - 1 ? ' / ' : ''}
                </span>
              ))}
            </p>
          </div>

          {/* Chat Input */}
          <footer className="p-3 bg-[#F0F2F5] flex items-center gap-2">
            <div className="flex items-center gap-1">
              <label className="p-2 transition-colors cursor-pointer text-slate-500 hover:bg-slate-200 rounded-full">
                <ImageIcon size={24} />
                <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
              </label>
              <label className="p-2 transition-colors cursor-pointer text-slate-500 hover:bg-slate-200 rounded-full">
                <Camera size={24} />
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
              </label>
            </div>
            
            <div className="flex-1 bg-white rounded-full px-4 py-2 flex items-center shadow-sm">
              <input 
                type="text" 
                placeholder={t('typeMessage')}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && inputText && (sendMessage(inputText), setInputText(''))}
                className="flex-1 bg-transparent focus:outline-none text-sm"
              />
            </div>

            <div className="flex items-center gap-1">
              {inputText ? (
                <button 
                  onClick={() => {
                    sendMessage(inputText);
                    setInputText('');
                  }}
                  className="p-3 bg-[#00A884] text-white rounded-full shadow-md hover:bg-[#008F6F] transition-all active:scale-95"
                >
                  <Send size={20} />
                </button>
              ) : (
                <div className="relative flex items-center">
                  <AnimatePresence>
                    {isRecording && (
                      <motion.div 
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        className="absolute right-14 bg-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 whitespace-nowrap"
                      >
                        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                        <span className="text-xs font-bold text-slate-600">Recording...</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <button 
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
                    onTouchEnd={(e) => { e.preventDefault(); stopRecording(); }}
                    className={`p-3 rounded-full shadow-md transition-all duration-300 ${
                      isRecording 
                        ? 'bg-red-500 scale-150 z-10 shadow-red-200' 
                        : 'bg-[#00A884] hover:bg-[#008F6F]'
                    } text-white`}
                  >
                    <Mic size={20} />
                  </button>
                </div>
              )}
            </div>
          </footer>
        </div>
      )}

      {/* --- Admin View --- */}
      {view === 'admin' && (
        <div className="flex h-screen bg-white">
          {/* Sidebar */}
          <aside className="w-80 border-r border-slate-200 flex flex-col">
            <header className="p-4 bg-slate-50 border-bottom border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="text-emerald-600" size={24} />
                <h2 className="font-bold">Admin Panel</h2>
              </div>
              <button onClick={() => setView('home')} className="p-2 hover:bg-slate-200 rounded-full text-slate-500">
                <LogOut size={20} />
              </button>
            </header>
            
            <div className="flex-1 overflow-y-auto">
              {customers.map(c => (
                <div 
                  key={c.id}
                  onClick={() => {
                    setSelectedAdminCustomer(c);
                    fetchMessages(c.id);
                    socket?.emit('markSeen', c.id);
                  }}
                  className={`p-4 border-b border-slate-100 cursor-pointer transition-colors ${
                    selectedAdminCustomer?.id === c.id ? 'bg-emerald-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-slate-200 rounded-full flex items-center justify-center text-slate-500">
                      <User size={24} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <h3 className="font-bold text-sm truncate">{c.phone || 'New Customer'}</h3>
                        <div className="flex items-center gap-2">
                          {unseenCounts[c.id] > 0 && (
                            <span className="w-5 h-5 bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full">
                              {unseenCounts[c.id]}
                            </span>
                          )}
                          <span className="text-[10px] text-slate-400">
                            {new Date(c.last_active).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 truncate">{c.address || 'No address provided'}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          {/* Admin Chat Area */}
          <main className="flex-1 flex flex-col">
            {selectedAdminCustomer ? (
              <>
                <header className="p-4 border-b border-slate-200 flex items-center justify-between bg-white">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400">
                      <User size={20} />
                    </div>
                    <div>
                      <h2 className="font-bold text-sm">{selectedAdminCustomer.phone}</h2>
                      <p className="text-xs text-slate-400">{selectedAdminCustomer.address}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-slate-400">
                    <Search size={20} />
                    <MoreVertical size={20} />
                  </div>
                </header>

                <div className="flex-1 p-6 overflow-y-auto bg-[#F0F2F5] whatsapp-bg space-y-4">
                  {messages.map(msg => (
                    <div 
                      key={msg.id} 
                      className={`flex ${msg.sender === 'admin' || msg.sender === 'ai' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`max-w-[70%] p-3 rounded-xl shadow-sm relative ${
                        msg.sender === 'admin' 
                          ? 'bg-emerald-600 text-white' 
                          : msg.sender === 'ai'
                            ? 'bg-emerald-100 text-emerald-900 border border-emerald-200'
                            : 'bg-white text-slate-800'
                      }`}>
                        {msg.sender === 'ai' && (
                          <div className="flex items-center gap-1 mb-1">
                            <Shield size={10} className="text-emerald-600" />
                            <span className="text-[8px] font-bold uppercase tracking-wider text-emerald-600">AI Assistant</span>
                          </div>
                        )}
                        {msg.type === 'text' && <p className="text-sm">{msg.content}</p>}
                        {msg.type === 'image' && <img src={msg.content} className="rounded-lg max-w-full" />}
                        {msg.type === 'audio' && <audio controls src={msg.content} className="h-8" />}
                        <div className="flex items-center justify-end gap-1 mt-1">
                          <span className={`text-[9px] ${msg.sender === 'admin' ? 'text-emerald-100' : 'text-slate-400'}`}>
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <footer className="p-4 bg-white border-t border-slate-200">
                  <div className="flex items-center gap-2">
                    <input 
                      type="text"
                      placeholder="Type a reply..."
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && inputText && (sendMessage(inputText, 'text', 'admin'), setInputText(''))}
                      className="flex-1 p-3 bg-slate-100 rounded-xl focus:outline-none text-sm"
                    />
                    <button 
                      onClick={() => {
                        sendMessage(inputText, 'text', 'admin');
                        setInputText('');
                      }}
                      className="p-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700"
                    >
                      <Send size={20} />
                    </button>
                  </div>
                </footer>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-50">
                <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                  <MessageCircle size={40} />
                </div>
                <h2 className="text-xl font-bold text-slate-600">Select a customer</h2>
                <p>Select a chat from the sidebar to start replying</p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
