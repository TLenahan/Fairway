import { DEEP_ANALYSIS_MODEL, MissingKeyError } from '@golf/analysis';
import {
  AnalysisRecord,
  AnalysisScope,
  AnalysisVerdict,
  SessionSummary,
} from '@golf/types';
import { Button, Card, Pill, SectionTitle, tw } from '@golf/ui';
import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { z } from 'zod';

import { useServices, useSettings } from '@/services/context';

type Scope = z.infer<typeof AnalysisScope>;
const SCOPES: Scope[] = ['session', 'trend', 'diagnose', 'plan'];

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const severityStyle: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-green-100 text-green-700',
  medium: 'bg-gold-100 text-gold-700',
  high: 'bg-danger/10 text-danger',
};

export default function AnalysisScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { analysis, analytics, data } = useServices();
  const analysisModel = useSettings((s) => s.analysisModel);
  const deepAnalysis = useSettings((s) => s.deepAnalysis);

  const [scope, setScope] = useState<Scope>('session');
  const [running, setRunning] = useState(false);
  const [narrative, setNarrative] = useState('');
  const [verdict, setVerdict] = useState<AnalysisVerdict | null>(null);
  const [priorAnalyses, setPriorAnalyses] = useState<AnalysisRecord[]>([]);
  const [error, setError] = useState<{
    message: string;
    missingKey: boolean;
  } | null>(null);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const summaryRef = useRef<SessionSummary | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!sessionId) return;
      void data.listAnalyses(sessionId).then((records) => {
        setPriorAnalyses(records);
        const last = records[0];
        if (last && !verdict) {
          setVerdict(last.verdict);
          setNarrative(last.narrative);
        }
      });
    }, [data, sessionId, verdict]),
  );

  const buildSummary = async (): Promise<SessionSummary> => {
    const [session, shots, clubs] = await Promise.all([
      data.getSession(sessionId),
      data.listShots(sessionId),
      data.listClubs({ includeArchived: true }),
    ]);
    if (!session) throw new Error('Session not found');
    return analytics.summarizeSession(shots, session.environment, clubs);
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setNarrative('');
    setVerdict(null);
    setChat([]);
    try {
      const summary = await buildSummary();
      summaryRef.current = summary;

      // trend compares against every other session's summary, oldest first
      let priorSummaries: SessionSummary[] | undefined;
      if (scope === 'trend') {
        const sessions = await data.listSessions();
        const others = sessions.filter((s) => s.id !== sessionId);
        priorSummaries = [];
        for (const other of others.reverse()) {
          const otherShots = await data.listShots(other.id);
          if (otherShots.length === 0) continue;
          const clubs = await data.listClubs({ includeArchived: true });
          priorSummaries.push(
            analytics.summarizeSession(otherShots, other.environment, clubs),
          );
        }
      }

      const result = await analysis.analyze(
        scope,
        {
          current: summary,
          priorSummaries,
          priorAnalyses,
          environment: summary.environment,
        },
        {
          model: deepAnalysis ? DEEP_ANALYSIS_MODEL : analysisModel,
          onDelta: (chunk) => setNarrative((text) => text + chunk),
        },
      );
      setVerdict(result.verdict);
      setNarrative(result.narrative);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        missingKey: err instanceof MissingKeyError,
      });
    } finally {
      setRunning(false);
    }
  };

  const sendChat = async () => {
    const message = chatInput.trim();
    if (!message || chatBusy) return;
    setChatInput('');
    setChatBusy(true);
    const history = chat;
    setChat([
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: '' },
    ]);
    try {
      const summary = summaryRef.current ?? (await buildSummary());
      summaryRef.current = summary;
      await analysis.chat(
        { summary, priorAnalysis: priorAnalyses[0] },
        history,
        message,
        {
          model: analysisModel,
          onDelta: (chunk) =>
            setChat((turns) => {
              const next = [...turns];
              const last = next[next.length - 1];
              next[next.length - 1] = {
                role: 'assistant',
                content: last.content + chunk,
              };
              return next;
            }),
        },
      );
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        missingKey: err instanceof MissingKeyError,
      });
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <ScrollView
      style={tw`flex-1 bg-ivory`}
      contentContainerStyle={tw`p-4 pb-16`}
    >
      <View style={tw`flex-row flex-wrap items-center gap-2`}>
        {SCOPES.map((s) => (
          <Pill
            key={s}
            label={s}
            selected={s === scope}
            onPress={() => setScope(s)}
          />
        ))}
        <Button
          label={
            running ? 'Analyzing…' : deepAnalysis ? 'Analyze (deep)' : 'Analyze'
          }
          compact
          loading={running}
          onPress={() => void run()}
        />
      </View>

      {error && (
        <Card style={tw`mt-3 border-danger`}>
          <Text style={tw`text-sm text-danger`}>{error.message}</Text>
          {error.missingKey && (
            <Link
              href="/settings"
              style={tw`mt-1 text-sm font-semibold text-green-700`}
            >
              Add your Anthropic API key in Settings →
            </Link>
          )}
        </Card>
      )}

      {narrative.length > 0 && (
        <>
          <SectionTitle title="Coach's read" />
          <Card>
            <Text style={tw`text-base leading-6 text-ink`}>{narrative}</Text>
          </Card>
        </>
      )}

      {verdict && (
        <>
          <SectionTitle title="Verdict" />
          <Card style={tw`mb-2 bg-green-900`}>
            <Text style={tw`text-base font-semibold text-ivory`}>
              {verdict.headline}
            </Text>
          </Card>
          {verdict.issues.map((issue) => (
            <Card key={issue.area} style={tw`mb-2`}>
              <View style={tw`flex-row items-center justify-between`}>
                <Text style={tw`font-semibold text-ink`}>{issue.area}</Text>
                <Text
                  style={tw.style(
                    'rounded-full px-2 py-0.5 text-xs font-semibold',
                    severityStyle[issue.severity],
                  )}
                >
                  {issue.severity}
                </Text>
              </View>
              <Text style={tw`mt-1 text-sm text-ink`}>{issue.evidence}</Text>
              <Text style={tw`mt-1 text-sm text-silver`}>{issue.why}</Text>
            </Card>
          ))}
          {verdict.drills.length > 0 && (
            <>
              <SectionTitle title="Drills" />
              {verdict.drills.map((drill) => (
                <Card key={drill.name} style={tw`mb-2`}>
                  <Text style={tw`font-semibold text-ink`}>{drill.name}</Text>
                  <Text style={tw`mt-1 text-sm text-ink`}>{drill.goal}</Text>
                  <Text style={tw`mt-1 text-xs text-computed`}>
                    Watch: {drill.howMeasured}
                  </Text>
                </Card>
              ))}
            </>
          )}
          {verdict.caveats.length > 0 && (
            <Text style={tw`mt-1 text-xs italic text-silver`}>
              {verdict.caveats.join(' · ')}
            </Text>
          )}
        </>
      )}

      {(verdict || priorAnalyses.length > 0) && (
        <>
          <SectionTitle title="Ask a follow-up" />
          {chat.map((turn, index) => (
            <View
              key={index}
              style={tw.style(
                'mb-2 max-w-[85%] rounded-2xl px-3 py-2',
                turn.role === 'user'
                  ? 'self-end bg-green-700'
                  : 'self-start bg-white border border-green-100',
              )}
            >
              <Text
                style={tw.style(
                  'text-sm',
                  turn.role === 'user' ? 'text-ivory' : 'text-ink',
                )}
              >
                {turn.content || '…'}
              </Text>
            </View>
          ))}
          <View style={tw`flex-row items-center gap-2`}>
            <TextInput
              style={tw`flex-1 rounded-xl border border-silver bg-white px-3 py-2.5`}
              placeholder="Why am I missing right?"
              value={chatInput}
              onChangeText={setChatInput}
              onSubmitEditing={() => void sendChat()}
            />
            <Button
              label="Send"
              compact
              loading={chatBusy}
              onPress={() => void sendChat()}
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}
