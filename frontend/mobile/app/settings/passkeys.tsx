/**
 * Passkeys — the keys that can authorise this wallet on chain.
 *
 * The Settings row for this existed with an empty handler, so tapping it did
 * nothing on mobile while the web wallet had the screen. This is the mobile
 * port of `frontend/wallet/app/settings/passkeys/page.tsx`, in the app's own
 * brand and with the mobile key store.
 *
 * Adding a passkey is how a wallet survives a lost phone: each one is an
 * independent signer on the wallet contract, so a passkey registered on a second
 * device can move the funds if the first device is gone. Removing the last one
 * is refused — that would leave a wallet nobody can authorise.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';

import { useWallet } from '../../components/WalletProvider';
import { useTheme } from '../../hooks/useTheme';
import { isWalletDeployed } from '../../lib/contractSpend';
import { deployWalletIfNeeded } from '../../lib/deployWallet';
import { errorMessage } from '../../lib/errorMessage';
import type { ThemeColors } from '../../lib/theme';
import { getPasskeyPublicKey, getSignerSecret, getWalletAddress } from '../../lib/walletStore';
import { fontFamily } from '../../theme/typography';

type Signer = { index: number; publicKey: string };

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  /** The wallet has no contract on chain yet, so it has no signer list to read. */
  | { kind: 'undeployed' }
  | { kind: 'error'; message: string };

function shortKey(publicKey: string): string {
  return publicKey.length > 20 ? `${publicKey.slice(0, 10)}…${publicKey.slice(-8)}` : publicKey;
}

export default function PasskeysScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { wallet } = useWallet();

  const [signers, setSigners] = useState<Signer[]>([]);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [thisDeviceKey, setThisDeviceKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const address = await getWalletAddress();
      if (!address) {
        setState({ kind: 'error', message: 'No wallet on this device yet.' });
        return;
      }
      if (address.startsWith('C') && !(await isWalletDeployed(address))) {
        setSigners([]);
        setState({ kind: 'undeployed' });
        return;
      }
      const list = (await wallet.getSigners()) as Signer[];
      setSigners(list);
      setState({ kind: 'ready' });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, [wallet]);

  useEffect(() => {
    void load();
    void getPasskeyPublicKey()
      .then((key) => setThisDeviceKey(key?.toLowerCase() ?? null))
      .catch(() => undefined);
  }, [load]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ text: await action(), ok: true });
      await load();
    } catch (err) {
      setStatus({ text: errorMessage(err), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const addPasskey = () =>
    run(async () => {
      const secret = await getSignerSecret();
      const address = await getWalletAddress();
      if (!secret || !address) throw new Error('Unlock the wallet again before adding a passkey.');

      const registered = await wallet.register('Veil wallet');
      if (!registered?.publicKeyBytes) throw new Error('That passkey did not return a public key.');

      // __check_auth cannot run against a wallet that is not on chain yet.
      await deployWalletIfNeeded(wallet.deploy, address);
      const result = await wallet.addSigner(Keypair.fromSecret(secret), registered.publicKeyBytes);
      return `Passkey added as signer #${result.signerIndex}.`;
    });

  const removePasskey = (index: number) =>
    run(async () => {
      const secret = await getSignerSecret();
      const address = await getWalletAddress();
      if (!secret || !address) throw new Error('Unlock the wallet again before removing a passkey.');

      await deployWalletIfNeeded(wallet.deploy, address);
      await wallet.removeSigner(Keypair.fromSecret(secret), index);
      return `Passkey #${index} removed.`;
    });

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Passkeys" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>
        Each passkey can authorise this wallet on chain. Add one on a second device so your money
        survives a lost phone.
      </Text>

      {state.kind === 'loading' ? (
        <View style={styles.card}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.hint}>Reading the wallet&apos;s signers…</Text>
        </View>
      ) : state.kind === 'undeployed' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Not on chain yet</Text>
          <Text style={styles.hint}>
            This wallet is set up on chain the first time it spends. Your passkey already controls
            it; the signer list appears here after that first transaction.
          </Text>
        </View>
      ) : state.kind === 'error' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Couldn&apos;t read your passkeys</Text>
          <Text style={styles.hint}>{state.message}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void load()}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.card}>
          {signers.map((signer) => {
            const isThisDevice =
              thisDeviceKey !== null && signer.publicKey.toLowerCase() === thisDeviceKey;
            return (
              <View key={signer.index} style={styles.signerRow}>
                <View style={styles.signerText}>
                  <Text style={styles.signerTitle}>
                    Passkey #{signer.index}
                    {isThisDevice ? ' · this device' : ''}
                  </Text>
                  <Text style={styles.mono}>{shortKey(signer.publicKey)}</Text>
                </View>
                {signers.length > 1 && !isThisDevice ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove passkey ${signer.index}`}
                    disabled={busy}
                    onPress={() => void removePasskey(signer.index)}
                    style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {signers.length === 0 ? (
            <Text style={styles.hint}>This wallet has no registered signers.</Text>
          ) : null}
          {signers.length === 1 ? (
            <Text style={styles.hint}>
              This is the only passkey on the wallet, so it can&apos;t be removed. Add another first.
            </Text>
          ) : null}
        </View>
      )}

      {status ? (
        <Text style={[styles.status, status.ok ? styles.good : styles.bad]}>{status.text}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        disabled={busy || state.kind === 'loading'}
        onPress={() => void addPasskey()}
        style={({ pressed }) => [
          styles.primary,
          (busy || state.kind === 'loading') && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.primaryText}>Add a passkey</Text>
        )}
      </Pressable>

      <Text style={styles.footnote}>
        Adding or removing a passkey is a transaction on your wallet contract, signed by the passkey
        you already have. It costs a fraction of a cent in network fees.
      </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    content: { padding: 20, paddingBottom: 48, gap: 14 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 18,
      gap: 12,
    },
    cardTitle: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.textStrong },
    hint: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    signerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    signerText: { flex: 1, gap: 3 },
    signerTitle: { fontFamily: fontFamily.bodyMedium, fontSize: 15, color: colors.textPrimary },
    mono: { fontFamily: fontFamily.address, fontSize: 12, color: colors.textMuted },
    remove: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    removeText: { fontFamily: fontFamily.bodyMedium, fontSize: 13, color: colors.danger },
    status: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    good: { color: colors.positive },
    bad: { color: colors.danger },
    primary: {
      alignItems: 'center',
      paddingVertical: 14,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { fontFamily: fontFamily.bodySemiBold, fontSize: 15, color: colors.onAccent },
    secondary: {
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    secondaryText: { fontFamily: fontFamily.bodyMedium, fontSize: 14, color: colors.textPrimary },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    footnote: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textFaint,
    },
  });
