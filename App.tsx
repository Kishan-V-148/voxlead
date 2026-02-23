
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Phone,
  PhoneOff,
  User,
  BarChart3,
  ShieldAlert,
  Clock,
  MessageSquare,
  Activity,
  ChevronRight,
  Settings,
  HelpCircle,
  TrendingUp,
  Users,
  AlertCircle,
  Volume2,
  Menu
} from 'lucide-react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage } from '@google/genai';
import { LeadScore, LeadStatus, CallSession, Message, ViewType, CallRecord } from './types';
import { decode, encode, decodeAudioData, createBlob } from './services/audioUtils';

const API_KEY = process.env.API_KEY;

const FAQ_KNOWLEDGE = `
NextGen CRM & Marketing Automation FAQ:
1. Product: NextGen CRM - Cloud-based customer management with AI insights.
2. Pricing: Basic ($99/mo), Pro ($299/mo), Enterprise (Custom).
3. Features: 24/7 Support, Omni-channel outreach, Real-time analytics, Zapier integration.
4. Onboarding: 15-minute setup, dedicated account manager for Enterprise.
5. Trial: 14-day free trial on Pro plan.
`;

const SYSTEM_INSTRUCTION = `
You are an AI-powered Voice Automation Assistant for NextGen Solutions, designed for marketing and lead qualification calls.

Your Role:
- Handle inbound and outbound marketing calls
- Answer FAQs using provided company knowledge
- Understand user intent
- Qualify leads
- Collect key customer details
- Escalate high-intent leads

Communication Rules:
- Speak naturally and professionally
- Keep responses short (2–3 sentences max)
- Ask only one question at a time
- Do not give long explanations
- Never invent pricing, offers, or features
- If unsure, say: "Let me confirm that with our team."

Intent Classification (internally classify every message into ONE):
- FAQ
- Pricing
- Product Interest
- Purchase Intent
- Callback Request
- Not Interested

Lead Level Classification:
- LOW: General questions only
- MEDIUM: Asking pricing or implementation
- HIGH: Ready to buy, wants demo, has timeline or budget

If HIGH:
- Mark internally:
  LEAD_STATUS: HIGH_PRIORITY
  ESCALATE_TO_SALES: YES

During conversation, collect naturally:
- Name
- Company
- Role
- Phone
- Email
- Budget (if mentioned)
- Timeline (if mentioned)
- Use case

Conversation Flow:
1. Greet briefly
2. Understand their need
3. Ask qualifying questions
4. Respond based on intent level
5. Offer demo or callback if high intent

At the end of the call, generate:

CALL_SUMMARY:
Name:
Company:
Role:
Intent_Type:
Lead_Level:
Budget:
Timeline:
Use_Case:
Next_Action:
Escalation: Yes/No

CRITICAL: For every response where intent or score changes, you MUST call 'updateLeadStatus' tool.
`;

const updateLeadStatusFn: FunctionDeclaration = {
  name: 'updateLeadStatus',
  description: 'Update the lead qualification status based on conversation context.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, description: 'Detected user intent' },
      score: { type: Type.STRING, enum: ['Low', 'Medium', 'High'], description: 'Lead qualification score' },
      escalate: { type: Type.BOOLEAN, description: 'Whether to escalate to a human agent' }
    },
    required: ['intent', 'score', 'escalate']
  }
};

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewType>('live');
  const [selectedVoice, setSelectedVoice] = useState<'Kore' | 'Zephyr'>('Kore');
  const [session, setSession] = useState<CallSession>({
    id: 'CALL-' + Math.random().toString(36).substr(2, 9).toUpperCase(),
    status: 'idle',
    leadStatus: { intent: 'None', score: LeadScore.LOW, escalate: false, lastUpdate: '--' },
    history: []
  });

  const [pastCalls, setPastCalls] = useState<CallRecord[]>(() => {
    const saved = localStorage.getItem('voxlead_history');
    return saved ? JSON.parse(saved) : [];
  });

  const [isConnecting, setIsConnecting] = useState(false);

  const audioContexts = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const sessionPromise = useRef<any>(null);
  const nextStartTime = useRef(0);
  const sources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentTurnTranscript = useRef({ user: '', model: '' });
  const [displayHistory, setDisplayHistory] = useState<Message[]>([]);
  const callStartTime = useRef<number>(0);

  // Visualizer Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const analysers = useRef<{ input: AnalyserNode; output: AnalyserNode } | null>(null);

  useEffect(() => {
    localStorage.setItem('voxlead_history', JSON.stringify(pastCalls));
  }, [pastCalls]);

  const stopCall = useCallback(() => {
    if (sessionPromise.current) {
      sessionPromise.current.then((s: any) => s.close());
    }
    audioContexts.current?.input.close();
    audioContexts.current?.output.close();

    const duration = Math.floor((Date.now() - callStartTime.current) / 1000);
    const durationStr = `${Math.floor(duration / 60)}m ${duration % 60}s`;

    const record: CallRecord = {
      ...session,
      status: 'ended',
      history: [...displayHistory],
      duration: durationStr,
      timestamp: new Date().toLocaleString()
    };

    setPastCalls(prev => [record, ...prev]);
    setSession(prev => ({ ...prev, status: 'ended' }));
    setIsConnecting(false);
  }, [session, displayHistory]);

  const startCall = useCallback(async () => {
    if (!API_KEY) return;
    setIsConnecting(true);
    callStartTime.current = Date.now();
    setSession({
      id: 'CALL-' + Math.random().toString(36).substr(2, 9).toUpperCase(),
      status: 'active',
      history: [],
      leadStatus: { intent: 'Discovery', score: LeadScore.LOW, escalate: false, lastUpdate: new Date().toLocaleTimeString() }
    });
    setDisplayHistory([]);
    currentTurnTranscript.current = { user: '', model: '' };

    try {

      const ai = new GoogleGenAI({ apiKey: API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      audioContexts.current = { input: inputCtx, output: outputCtx };

      // Initialize Analysers
      const inputAnalyser = inputCtx.createAnalyser();
      inputAnalyser.fftSize = 256;
      inputAnalyser.smoothingTimeConstant = 0.5;

      const outputAnalyser = outputCtx.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputAnalyser.smoothingTimeConstant = 0.5;

      analysers.current = { input: inputAnalyser, output: outputAnalyser };

      sessionPromise.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [updateLeadStatusFn] }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
          }
        },
        callbacks: {
          onopen: () => {
            setSession(prev => ({ ...prev, status: 'connected' }));
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);

            // Connect Input Analyser
            source.connect(inputAnalyser);
            inputAnalyser.connect(scriptProcessor);

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.current.then((s: any) => s.sendRealtimeInput({ media: pcmBlob }));
            };
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const base64Audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;

              // Connect Output Analyser
              if (analysers.current) {
                source.connect(analysers.current.output);
                analysers.current.output.connect(outputCtx.destination);
              } else {
                source.connect(outputCtx.destination);
              }

              nextStartTime.current = Math.max(nextStartTime.current, outputCtx.currentTime);
              source.start(nextStartTime.current);
              nextStartTime.current += audioBuffer.duration;
              sources.current.add(source);
              source.onended = () => sources.current.delete(source);
            }

            if (msg.serverContent?.inputTranscription) currentTurnTranscript.current.user += msg.serverContent.inputTranscription.text;
            if (msg.serverContent?.outputTranscription) currentTurnTranscript.current.model += msg.serverContent.outputTranscription.text;

            if (msg.serverContent?.turnComplete) {
              const userMsg: Message = { role: 'user', text: currentTurnTranscript.current.user, timestamp: new Date().toLocaleTimeString() };
              const assistantMsg: Message = { role: 'assistant', text: currentTurnTranscript.current.model, timestamp: new Date().toLocaleTimeString() };
              if (userMsg.text) setDisplayHistory(prev => [...prev, userMsg]);
              if (assistantMsg.text) setDisplayHistory(prev => [...prev, assistantMsg]);
              currentTurnTranscript.current = { user: '', model: '' };
            }

            if (msg.serverContent?.interrupted) {
              sources.current.forEach(s => s.stop());
              sources.current.clear();
              nextStartTime.current = 0;
            }

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'updateLeadStatus') {
                  const args = fc.args as any;
                  setSession(prev => ({
                    ...prev,
                    leadStatus: {
                      intent: args.intent,
                      score: args.score as LeadScore,
                      escalate: args.escalate,
                      lastUpdate: new Date().toLocaleTimeString()
                    }
                  }));
                  sessionPromise.current.then((s: any) =>
                    s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } })
                  );
                }
              }
            }
          },
          onclose: () => setSession(prev => ({ ...prev, status: 'ended' })),
          onerror: (err) => { console.error(err); setSession(prev => ({ ...prev, status: 'ended' })); }
        }
      });
    } catch (err) {
      console.error(err);
      setIsConnecting(false);
    }
  }, [selectedVoice]);

  const handleAssignAgent = useCallback((id: string) => {
    setPastCalls(prev => prev.map(call => {
      if (call.id === id) {
        return {
          ...call,
          leadStatus: { ...call.leadStatus, escalate: false }
        };
      }
      return call;
    }));
  }, []);

  const stats = useMemo(() => {
    const total = pastCalls.length;
    const high = pastCalls.filter(c => c.leadStatus.score === LeadScore.HIGH).length;
    const med = pastCalls.filter(c => c.leadStatus.score === LeadScore.MEDIUM).length;
    const low = pastCalls.filter(c => c.leadStatus.score === LeadScore.LOW).length;
    const escalated = pastCalls.filter(c => c.leadStatus.escalate).length;
    return { total, high, med, low, escalated };
  }, [pastCalls]);

  useEffect(() => {
    if (session.status !== 'connected' || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      if (!analysers.current) return;

      const WIDTH = canvas.width;
      const HEIGHT = canvas.height;
      const { input, output } = analysers.current;

      const inputData = new Uint8Array(input.frequencyBinCount);
      const outputData = new Uint8Array(output.frequencyBinCount);

      input.getByteFrequencyData(inputData);
      output.getByteFrequencyData(outputData);

      // Determine active source (Output overrides Input for simpler visual)
      // Or mix them: Left side input, Right side output? Maybe mirrored combined.
      const dataArray = new Uint8Array(inputData.length);
      let isActive = false;

      // Check output activity
      let outputSum = 0;
      for (let i = 0; i < outputData.length; i++) outputSum += outputData[i];
      if (outputSum > 1000) { // arbitrary threshold
        for (let i = 0; i < outputData.length; i++) dataArray[i] = outputData[i];
        isActive = true;
      } else {
        // Fallback to input
        for (let i = 0; i < inputData.length; i++) dataArray[i] = inputData[i];
      }

      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      // Smooth visualizer style
      const barWidth = (WIDTH / dataArray.length) * 2.5;
      let barHeight;
      let x = 0;

      // Mirrored visualizer
      const centerX = WIDTH / 2;

      for (let i = 0; i < dataArray.length; i++) {
        barHeight = dataArray[i] / 2; // Scale down

        // Gradient color based on height/activity
        const gradient = ctx.createLinearGradient(0, HEIGHT / 2 - barHeight, 0, HEIGHT / 2 + barHeight);
        gradient.addColorStop(0, '#3b82f6'); // Blue-500
        gradient.addColorStop(1, '#60a5fa'); // Blue-400

        ctx.fillStyle = isActive ? (outputSum > 1000 ? '#60a5fa' : '#34d399') : '#3b82f6'; // Blue for output/idle, Green for input? 
        // actually let's keep it blue/purple theme
        ctx.fillStyle = outputSum > 1000 ? '#60a5fa' : '#a78bfa'; // Blue (AI), Purple (User)

        // Draw mirrored bars from center
        const h = Math.max(4, barHeight * 1.5); // Minimum height and scale
        const w = 4; // Fixed width bars look cleaner
        const gap = 6;
        const totalWidth = (dataArray.length / 4) * (w + gap); // Show fewer bars for cleaner look
        const startX = centerX - totalWidth / 2;

        // Only draw lower frequencies (first quarter) for cleaner voice spectrum
        if (i < dataArray.length / 4) {
          const xPos = startX + i * (w + gap);

          // Round caps
          ctx.beginPath();
          ctx.roundRect(xPos, HEIGHT / 2 - h / 2, w, h, 4);
          ctx.fill();
        }
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationRef.current);
  }, [session.status]);

  const renderContent = () => {
    const basePadding = "p-4 sm:p-6 lg:p-8";
    switch (currentView) {
      case 'live':
        return (
          <div className={`${basePadding} grid grid-cols-12 gap-4 sm:gap-6 lg:gap-8 animate-in fade-in duration-500`}>
            <div className="col-span-12 lg:col-span-7 space-y-6 lg:space-y-8">
              <section className="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 lg:mb-8">
                  <div>
                    <h2 className="text-xl sm:text-2xl font-bold">Call Console</h2>
                    <p className="text-slate-400 text-xs sm:text-sm">Session ID: {session.id}</p>
                  </div>
                  <div className="flex w-full sm:w-auto space-x-4">
                    {session.status === 'idle' || session.status === 'ended' ? (
                      <button
                        onClick={startCall}
                        disabled={isConnecting}
                        className="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-500 text-white px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-lg shadow-blue-900/40"
                      >
                        <Phone className="w-4 sm:w-5 h-4 sm:h-5" />
                        <span className="text-sm sm:text-base">{isConnecting ? 'Connecting...' : 'Start Automation'}</span>
                      </button>
                    ) : (
                      <button
                        onClick={stopCall}
                        className="flex-1 sm:flex-none bg-red-600 hover:bg-red-500 text-white px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-lg shadow-red-900/40"
                      >
                        <PhoneOff className="w-4 sm:w-5 h-4 sm:h-5" />
                        <span className="text-sm sm:text-base">End Call</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="h-32 sm:h-40 lg:h-48 bg-slate-900/50 rounded-xl flex items-center justify-center border border-slate-800 mb-6 relative overflow-hidden">
                  {session.status === 'connected' ? (
                    <canvas
                      ref={canvasRef}
                      width={600}
                      height={200}
                      className="w-full h-full opacity-90"
                    />
                  ) : (
                    <div className="text-slate-600 flex flex-col items-center">
                      <Activity className="w-10 sm:w-12 h-10 sm:h-12 mb-2 opacity-20" />
                      <p className="text-xs sm:text-sm">Waiting for connection...</p>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Live Transcript</h3>
                  <div className="h-48 sm:h-64 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                    {displayHistory.map((m, idx) => (
                      <div key={idx} className={`flex flex-col ${m.role === 'user' ? 'items-start' : 'items-end'}`}>
                        <div className={`max-w-[90%] sm:max-w-[85%] rounded-2xl p-2.5 sm:p-3 text-xs sm:text-sm ${m.role === 'user' ? 'bg-slate-800 rounded-bl-none' : 'bg-blue-900/30 border border-blue-800 rounded-br-none'
                          }`}>
                          <p>{m.text}</p>
                        </div>
                        <span className="text-[10px] text-slate-500 mt-1">{m.timestamp}</span>
                      </div>
                    ))}
                    {currentTurnTranscript.current.user && (
                      <div className="flex flex-col items-start opacity-50 italic">
                        <div className="bg-slate-800 rounded-2xl rounded-bl-none p-2.5 sm:p-3 text-xs sm:text-sm">{currentTurnTranscript.current.user}...</div>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <div className="col-span-12 lg:col-span-5 space-y-6 lg:space-y-8">
              <section className="glass-panel rounded-2xl p-4 sm:p-6">
                <h2 className="text-lg font-bold mb-4 sm:mb-6 flex items-center space-x-2">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                  <span>Lead Intelligence</span>
                </h2>
                <div className="space-y-4 sm:space-y-6">
                  <div className="p-3 sm:p-4 bg-slate-900/50 border border-slate-800 rounded-xl">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs sm:text-sm text-slate-400">Qualification Score</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${session.leadStatus.score === LeadScore.HIGH ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                        session.leadStatus.score === LeadScore.MEDIUM ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' :
                          'bg-green-500/20 text-green-400 border border-green-500/30'
                        }`}>
                        {session.leadStatus.score} Intent
                      </span>
                    </div>
                    <div className="h-1.5 sm:h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-700 ${session.leadStatus.score === LeadScore.HIGH ? 'w-full bg-red-500' :
                          session.leadStatus.score === LeadScore.MEDIUM ? 'w-2/3 bg-yellow-500' :
                            'w-1/3 bg-green-500'
                          }`}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <StatCard label="Detected Intent" value={session.leadStatus.intent} />
                    <StatCard label="Last Updated" value={session.leadStatus.lastUpdate} />
                  </div>
                  <div className={`p-3 sm:p-4 rounded-xl border flex items-center space-x-3 sm:space-x-4 transition-all ${session.leadStatus.escalate ? 'bg-red-500/10 border-red-500/40 text-red-100' : 'bg-slate-900/50 border-slate-800 text-slate-400'
                    }`}>
                    <div className={`p-1.5 sm:p-2 rounded-lg ${session.leadStatus.escalate ? 'bg-red-500 text-white' : 'bg-slate-800 text-slate-500'}`}>
                      <ShieldAlert className="w-4 sm:w-5 h-4 sm:h-5" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-xs sm:text-sm">Escalation Status</h4>
                      <p className="text-[10px] sm:text-xs">{session.leadStatus.escalate ? 'Flagged for Human' : 'Fully Automated'}</p>
                    </div>
                  </div>
                </div>
              </section>
              <section className="glass-panel rounded-2xl p-4 sm:p-6">
                <h2 className="text-lg font-bold mb-3 sm:mb-4 flex items-center space-x-2">
                  <MessageSquare className="w-5 h-5 text-purple-400" />
                  <span>Knowledge Context</span>
                </h2>
                <div className="text-[10px] sm:text-xs text-slate-400 leading-relaxed bg-slate-900/50 p-3 sm:p-4 rounded-xl border border-slate-800 whitespace-pre-wrap">{FAQ_KNOWLEDGE}</div>
              </section>
            </div>
          </div>
        );
      case 'history':
        return (
          <div className={`${basePadding} space-y-4 sm:space-y-6 animate-in slide-in-from-bottom-4 duration-500`}>
            <h2 className="text-2xl sm:text-3xl font-bold">Call History</h2>
            <div className="glass-panel rounded-2xl overflow-hidden overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm min-w-[600px]">
                <thead className="bg-slate-900/80 border-b border-slate-800">
                  <tr>
                    <th className="p-3 sm:p-4 font-medium text-slate-400">ID & Timestamp</th>
                    <th className="p-3 sm:p-4 font-medium text-slate-400">Intent</th>
                    <th className="p-3 sm:p-4 font-medium text-slate-400">Lead Score</th>
                    <th className="p-3 sm:p-4 font-medium text-slate-400">Duration</th>
                    <th className="p-3 sm:p-4 font-medium text-slate-400">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {pastCalls.map((call) => (
                    <tr key={call.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="p-3 sm:p-4">
                        <div className="font-medium text-slate-200">{call.id}</div>
                        <div className="text-[9px] sm:text-[10px] text-slate-500">{call.timestamp}</div>
                      </td>
                      <td className="p-3 sm:p-4 text-slate-300">{call.leadStatus.intent}</td>
                      <td className="p-3 sm:p-4">
                        <span className={`px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold ${call.leadStatus.score === LeadScore.HIGH ? 'bg-red-500/20 text-red-400' :
                          call.leadStatus.score === LeadScore.MEDIUM ? 'bg-yellow-500/20 text-yellow-400' :
                            'bg-green-500/20 text-green-400'
                          }`}>
                          {call.leadStatus.score}
                        </span>
                      </td>
                      <td className="p-3 sm:p-4 text-slate-400">{call.duration}</td>
                      <td className="p-3 sm:p-4">
                        {call.leadStatus.escalate ? (
                          <span className="text-red-400 flex items-center space-x-1"><ShieldAlert className="w-3 h-3" /> <span className="hidden sm:inline">Escalated</span></span>
                        ) : (
                          <span className="text-green-400 flex items-center space-x-1"><Activity className="w-3 h-3" /> <span className="hidden sm:inline">Auto</span></span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {pastCalls.length === 0 && (
                    <tr><td colSpan={5} className="p-10 sm:p-12 text-center text-slate-600 italic">No call records found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'analytics':
        return (
          <div className={`${basePadding} space-y-6 sm:space-y-8 animate-in zoom-in-95 duration-500`}>
            <h2 className="text-2xl sm:text-3xl font-bold">Automation Insights</h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
              <AnalyticsCard icon={<Phone className="text-blue-400 w-4 h-4 sm:w-5 sm:h-5" />} title="Total Calls" value={stats.total.toString()} subtitle="Last 30 days" />
              <AnalyticsCard icon={<TrendingUp className="text-green-400 w-4 h-4 sm:w-5 sm:h-5" />} title="Avg Score" value="Medium" subtitle="Intent dist." />
              <AnalyticsCard icon={<ShieldAlert className="text-red-400 w-4 h-4 sm:w-5 sm:h-5" />} title="Escalations" value={stats.escalated.toString()} subtitle="Human intervention" />
              <AnalyticsCard icon={<Users className="text-purple-400 w-4 h-4 sm:w-5 sm:h-5" />} title="Lead Conv." value={`${stats.total > 0 ? Math.round((stats.high / stats.total) * 100) : 0}%`} subtitle="High intent rate" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
              <section className="glass-panel rounded-2xl p-4 sm:p-6">
                <h3 className="font-bold mb-4 sm:mb-6 text-sm sm:text-base">Lead Quality Distribution</h3>
                <div className="space-y-4">
                  <ProgressBar label="High Intent" count={stats.high} total={stats.total} color="bg-red-500" />
                  <ProgressBar label="Medium Intent" count={stats.med} total={stats.total} color="bg-yellow-500" />
                  <ProgressBar label="Low Intent" count={stats.low} total={stats.total} color="bg-green-500" />
                </div>
              </section>
              <section className="glass-panel rounded-2xl p-4 sm:p-6">
                <h3 className="font-bold mb-4 sm:mb-6 text-sm sm:text-base">Automation Efficiency</h3>
                <div className="flex items-center justify-center h-40 sm:h-48 border border-slate-800 rounded-xl bg-slate-900/30">
                  <div className="text-center">
                    <div className="text-3xl sm:text-4xl font-bold text-blue-400">{stats.total > 0 ? Math.round(((stats.total - stats.escalated) / stats.total) * 100) : 0}%</div>
                    <div className="text-[10px] sm:text-xs text-slate-500 mt-2 uppercase tracking-widest">Self-Service Rate</div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        );
      case 'escalations':
        const escalatedLeads = pastCalls.filter(c => c.leadStatus.escalate);
        return (
          <div className={`${basePadding} space-y-4 sm:space-y-6 animate-in slide-in-from-right-4 duration-500`}>
            <h2 className="text-2xl sm:text-3xl font-bold">Escalation Queue</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {escalatedLeads.map(lead => (
                <div key={lead.id} className="glass-panel rounded-2xl p-4 sm:p-6 border-l-4 border-red-500 hover:scale-[1.01] transition-transform">
                  <div className="flex justify-between items-start mb-3 sm:mb-4">
                    <div className="p-1.5 sm:p-2 bg-red-500/20 rounded-lg"><AlertCircle className="w-4 sm:w-5 h-4 sm:h-5 text-red-500" /></div>
                    <span className="text-[9px] sm:text-[10px] text-slate-500">{lead.timestamp}</span>
                  </div>
                  <h3 className="font-bold text-base sm:text-lg mb-1">{lead.id}</h3>
                  <p className="text-xs sm:text-sm text-slate-400 mb-3 sm:mb-4">Intent: <span className="text-slate-200">{lead.leadStatus.intent}</span></p>
                  <div className="flex flex-col space-y-2 mb-4">
                    <div className="text-[9px] sm:text-[10px] uppercase text-slate-500 font-bold">Last User Query</div>
                    <p className="text-[11px] sm:text-xs italic bg-slate-900/80 p-2 sm:p-3 rounded-lg border border-slate-800 line-clamp-2">
                      "{lead.history.filter(m => m.role === 'user').pop()?.text || 'No transcript available'}"
                    </p>
                  </div>
                  <button
                    onClick={() => handleAssignAgent(lead.id)}
                    className="w-full bg-slate-800 hover:bg-slate-700 text-slate-100 py-2 rounded-xl text-xs sm:text-sm transition-all border border-slate-700 active:scale-95"
                  >
                    Assign to Agent
                  </button>
                </div>
              ))}
              {escalatedLeads.length === 0 && (
                <div className="col-span-full py-16 sm:py-20 text-center glass-panel rounded-2xl">
                  <ShieldAlert className="w-10 sm:w-12 h-10 sm:h-12 text-slate-700 mx-auto mb-4" />
                  <p className="text-slate-500 text-sm sm:text-base font-medium px-4">No active escalations. Automation is handling everything!</p>
                </div>
              )}
            </div>
          </div>
        );
      case 'settings':
        return (
          <div className={`${basePadding} max-w-2xl animate-in fade-in duration-500`}>
            <h2 className="text-2xl sm:text-3xl font-bold mb-6 sm:mb-8">Agent Settings</h2>
            <div className="space-y-6">
              <section className="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
                <h3 className="font-bold flex items-center space-x-2 text-sm sm:text-base"><Volume2 className="w-4 h-4 text-blue-400" /> <span>Voice Profile</span></h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <button
                    onClick={() => setSelectedVoice('Kore')}
                    className={`text-left p-3 sm:p-4 bg-slate-800/50 border-2 rounded-xl relative transition-all ${selectedVoice === 'Kore' ? 'border-blue-600 ring-1 ring-blue-600/20' : 'border-slate-800 hover:border-slate-700'
                      }`}
                  >
                    <div className="font-bold text-sm sm:text-base">Kore</div>
                    <div className="text-[10px] sm:text-xs text-slate-400 italic">Professional & Calm</div>
                    {selectedVoice === 'Kore' && <div className="absolute top-2 right-2 w-1.5 h-1.5 sm:w-2 sm:h-2 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.8)]"></div>}
                  </button>
                  <button
                    onClick={() => setSelectedVoice('Zephyr')}
                    className={`text-left p-3 sm:p-4 bg-slate-800/50 border-2 rounded-xl relative transition-all ${selectedVoice === 'Zephyr' ? 'border-blue-600 ring-1 ring-blue-600/20' : 'border-slate-800 hover:border-slate-700'
                      }`}
                  >
                    <div className="font-bold text-sm sm:text-base">Zephyr</div>
                    <div className="text-[10px] sm:text-xs text-slate-400 italic">Friendly & Casual</div>
                    {selectedVoice === 'Zephyr' && <div className="absolute top-2 right-2 w-1.5 h-1.5 sm:w-2 sm:h-2 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.8)]"></div>}
                  </button>
                </div>
              </section>
              <section className="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
                <h3 className="font-bold text-sm sm:text-base">System Instructions</h3>
                <div className="text-[10px] sm:text-xs text-slate-500 italic mb-1 sm:mb-2">Configure AI behavior guidelines.</div>
                <textarea
                  className="w-full h-32 sm:h-48 bg-slate-900 border border-slate-800 rounded-xl p-3 sm:p-4 text-[10px] sm:text-xs font-mono text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  defaultValue={SYSTEM_INSTRUCTION}
                />
              </section>
              <div className="flex justify-end">
                <button className="w-full sm:w-auto bg-blue-600 hover:bg-blue-500 text-white px-6 sm:px-8 py-2.5 sm:py-3 rounded-xl text-sm sm:text-base font-bold transition-all shadow-lg shadow-blue-900/40">Save Configuration</button>
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden text-slate-200 bg-slate-950">
      {/* Sidebar - Desktop Only */}
      <aside className="hidden lg:flex w-64 glass-panel border-r flex flex-col p-4 space-y-6 shrink-0 z-20">
        <div className="flex items-center space-x-3 px-2 cursor-pointer" onClick={() => setCurrentView('live')}>
          <div className="bg-blue-600 p-2 rounded-lg"><Phone className="w-6 h-6 text-white" /></div>
          <h1 className="text-xl font-bold tracking-tight">VoxLead AI</h1>
        </div>
        <nav className="flex-1 space-y-2">
          <NavItem icon={<Activity className="w-5 h-5" />} label="Live Call" active={currentView === 'live'} onClick={() => setCurrentView('live')} />
          <NavItem icon={<Clock className="w-5 h-5" />} label="History" active={currentView === 'history'} onClick={() => setCurrentView('history')} />
          <NavItem icon={<BarChart3 className="w-5 h-5" />} label="Analytics" active={currentView === 'analytics'} onClick={() => setCurrentView('analytics')} />
          <NavItem icon={<ShieldAlert className="w-5 h-5" />} label="Escalations" active={currentView === 'escalations'} onClick={() => setCurrentView('escalations')} />
        </nav>
        <div className="space-y-2 pt-6 border-t border-slate-700">
          <NavItem icon={<Settings className="w-5 h-5" />} label="Settings" active={currentView === 'settings'} onClick={() => setCurrentView('settings')} />
          <NavItem icon={<HelpCircle className="w-5 h-5" />} label="Support" onClick={() => { }} />
        </div>
      </aside>

      {/* Mobile Navigation Bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-16 glass-panel border-t border-slate-800 flex items-center justify-around px-2 z-50">
        <MobileNavItem icon={<Activity className="w-5 h-5" />} active={currentView === 'live'} onClick={() => setCurrentView('live')} />
        <MobileNavItem icon={<Clock className="w-5 h-5" />} active={currentView === 'history'} onClick={() => setCurrentView('history')} />
        <MobileNavItem icon={<BarChart3 className="w-5 h-5" />} active={currentView === 'analytics'} onClick={() => setCurrentView('analytics')} />
        <MobileNavItem icon={<ShieldAlert className="w-5 h-5" />} active={currentView === 'escalations'} onClick={() => setCurrentView('escalations')} />
        <MobileNavItem icon={<Settings className="w-5 h-5" />} active={currentView === 'settings'} onClick={() => setCurrentView('settings')} />
      </nav>

      {/* Main Container */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        <header className="h-14 sm:h-16 flex items-center justify-between px-4 sm:px-8 border-b border-slate-800 shrink-0 bg-slate-950/50 backdrop-blur-md z-30">
          <div className="flex items-center space-x-3">
            <div className="lg:hidden bg-blue-600 p-1.5 rounded-lg mr-1"><Phone className="w-4 h-4 text-white" /></div>
            <div className="flex items-center space-x-2">
              <span className={`w-1.5 sm:w-2 h-1.5 sm:h-2 rounded-full ${session.status === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`}></span>
              <span className="text-xs sm:text-sm font-medium text-slate-400 capitalize">{currentView} View</span>
            </div>
          </div>
          <div className="flex items-center space-x-3 sm:space-x-6 text-xs sm:text-sm">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-slate-500 text-[10px] sm:text-xs">Agent</span>
              <span className="font-medium">{selectedVoice} (US)</span>
            </div>
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700 shadow-sm shadow-black/50"><User className="w-3 sm:w-4 h-3 sm:h-4 text-slate-300" /></div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pb-16 lg:pb-0 relative scroll-smooth">
          {renderContent()}
        </div>
      </main>
    </div>
  );
};

// Sidebar Navigation Item (Desktop Only)
const NavItem: React.FC<{ icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center space-x-3 px-3 py-2 rounded-xl text-sm font-medium transition-all group ${active ? 'bg-blue-600/10 text-blue-400 border border-blue-600/20 shadow-inner' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
      }`}
  >
    <span className={`${active ? 'text-blue-400 scale-110' : 'text-slate-500 group-hover:text-slate-300'} transition-transform duration-200`}>{icon}</span>
    <span>{label}</span>
    {active && <ChevronRight className="w-4 h-4 ml-auto opacity-50" />}
  </button>
);

// Mobile Bottom Bar Item
const MobileNavItem: React.FC<{ icon: React.ReactNode; active?: boolean; onClick: () => void }> = ({ icon, active, onClick }) => (
  <button
    onClick={onClick}
    className={`flex-1 flex items-center justify-center py-3 relative transition-all active:scale-90 ${active ? 'text-blue-400' : 'text-slate-500'
      }`}
  >
    <div className={`transition-transform duration-300 ${active ? 'scale-125' : 'scale-100'}`}>
      {icon}
    </div>
    {active && (
      <span className="absolute top-2 w-1 h-1 bg-blue-400 rounded-full shadow-[0_0_8px_rgba(96,165,250,0.8)]"></span>
    )}
  </button>
);

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="p-3 sm:p-4 bg-slate-900/50 border border-slate-800 rounded-xl shadow-sm">
    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</p>
    <p className="text-xs sm:text-sm font-bold truncate text-slate-100">{value}</p>
  </div>
);

const AnalyticsCard: React.FC<{ icon: React.ReactNode; title: string; value: string; subtitle: string }> = ({ icon, title, value, subtitle }) => (
  <div className="glass-panel p-4 sm:p-6 rounded-2xl space-y-2 relative overflow-hidden group">
    <div className="flex justify-between items-start">
      <div className="p-1.5 sm:p-2 bg-slate-800 rounded-lg group-hover:bg-slate-700 transition-colors">{icon}</div>
      <span className="text-[9px] sm:text-[10px] text-green-400 font-bold bg-green-400/10 px-1.5 py-0.5 rounded">+12%</span>
    </div>
    <h4 className="text-slate-400 text-xs sm:text-sm font-medium">{title}</h4>
    <div className="text-xl sm:text-2xl font-bold text-slate-100">{value}</div>
    <p className="text-[9px] sm:text-[10px] text-slate-500">{subtitle}</p>
  </div>
);

const ProgressBar: React.FC<{ label: string; count: number; total: number; color: string }> = ({ label, count, total, color }) => (
  <div className="space-y-1.5">
    <div className="flex justify-between text-[10px] sm:text-xs font-medium">
      <span className="text-slate-300">{label}</span>
      <span className="text-slate-500 font-mono">{count} ({total > 0 ? Math.round((count / total) * 100) : 0}%)</span>
    </div>
    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
      <div className={`h-full ${color} transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(0,0,0,0.5)]`} style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} />
    </div>
  </div>
);

export default App;
