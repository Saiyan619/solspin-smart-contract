import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solspin } from "../target/types/solspin";
import { assert, expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";

describe("solspin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Solspin as Program<Solspin>;

  it("Admin initialized the Game Vault", async () => {
    const signer = provider.wallet.publicKey;
    const [escrowVaultPDA, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault")],
      program.programId
    );

    try {
      const tx = await program.methods
        .initializeHouse()
        .accounts({
          admin: signer,
        })
        .rpc();
      console.log("Vault initialized:", tx);
    } catch (err) {
      if (err.toString().includes("already in use")) {
        console.log("Vault already initialized (skipping)");
      } else {
        throw err;
      }
    }

    const accountInfo = await program.provider.connection.getAccountInfo(
      escrowVaultPDA
    );
    assert.ok(accountInfo !== null);
    assert.ok(accountInfo.owner.equals(program.programId));
    assert.ok(accountInfo.data.length === 8);
    console.log("Vault successfully initialized: ", escrowVaultPDA.toBase58());
  });

  it("Player Initializing game", async () => {
    // Use a fresh player for this test to avoid leftover state
    const player = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      player.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    const [gameStatePDA, bump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("game_state"), player.publicKey.toBuffer()],
        program.programId
      );

    try {
      const tx = await program.methods
        .initialize()
        .accounts({
          signer: player.publicKey,
        })
        .rpc();
      console.log("Transaction:", tx);
    } catch (err) {
      if (err.toString().includes("already in use")) {
        console.log("Game state already initialized (skipping)");
      } else {
        throw err;
      }
    }

    // 1. Account exists
    const account = await program.provider.connection.getAccountInfo(
      gameStatePDA
    );
    expect(account).to.not.be.null;

    // 2. Initial values correct
    const state = await program.account.gameState.fetch(gameStatePDA);
    expect(state.wager.toNumber()).to.equal(0);
    expect(state.playerGuess).to.equal(0);
    expect(state.commitSlot.toNumber()).to.equal(0);
    expect(state.vrfAcc.toString()).to.equal(PublicKey.default.toString());
    expect(state.maxResult).to.equal(6);

    // 3. Correct PDA
    const [derivedPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_state"), player.publicKey.toBuffer()],
      program.programId
    );
    expect(gameStatePDA.toString()).to.equal(derivedPDA.toString());

    console.log("Game state PDA:", gameStatePDA.toBase58());

    // 4. Can't init twice
    try {
      await program.methods
        .initialize()
        .accounts({
          signer: player.publicKey,
        })
        .rpc();
      expect.fail("Should not allow double initialization");
    } catch (err) {
      expect(err.toString()).to.include("already in use");
    }
  });

  it("call spin and request randomness (full commit-reveal)", async () => {
    const { keypair, connection, program: sbProgram } = await sb.AnchorUtils.loadEnv();
    const myProgram = program; // Your Solspin program

    const queue = await sb.getDefaultQueue(connection.rpcEndpoint);
    console.log("Queue account:", queue.pubkey.toBase58());

    const rngKp = Keypair.generate();
    console.log("Randomness account:", rngKp.publicKey.toBase58());

    const [randomness, createIx] = await sb.Randomness.create(
      sbProgram,
      rngKp,
      queue.pubkey
    );

    const createTx = await sb.asV0Tx({
      connection,
      ixs: [createIx],
      payer: keypair.publicKey,
      signers: [keypair, rngKp],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    const createSig = await connection.sendTransaction(createTx);
    await connection.confirmTransaction(createSig, "confirmed");
    console.log("Randomness account created:", createSig);

    // Commit Phase
    const playerGuess = 3; // 1–6 now
    const wagerAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

    const commitIx = await randomness.commitIx(queue.pubkey);

    const [gameStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_state"), keypair.publicKey.toBuffer()],
      myProgram.programId
    );
    const [escrowVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault")],
      myProgram.programId
    );

    const spinIx = await myProgram.methods
      .callSpin(playerGuess, rngKp.publicKey, wagerAmount)
      .accounts({
        gameState: gameStatePDA,
        escrowVault: escrowVaultPDA,
        randomnessData: rngKp.publicKey,
        signer: keypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const commitTx = await sb.asV0Tx({
      connection,
      ixs: [commitIx, spinIx],
      payer: keypair.publicKey,
      signers: [keypair],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    const commitSig = await connection.sendTransaction(commitTx);
    await connection.confirmTransaction(commitSig, "confirmed");
    console.log("Committed to randomness and called spin:", commitSig);

    // Verify game state
    const gameStateAfterCommit = await myProgram.account.gameState.fetch(gameStatePDA);
    expect(gameStateAfterCommit.playerGuess).to.equal(playerGuess);
    expect(gameStateAfterCommit.vrfAcc.toString()).to.equal(rngKp.publicKey.toString());
    expect(gameStateAfterCommit.wager.toNumber()).to.equal(wagerAmount.toNumber());
    console.log("Game state updated with guess and randomness account");
    console.log("Wager deposited:", wagerAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");

    // Wait for slot to advance
    console.log("Waiting 3 seconds for slot to advance...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Reveal Phase
    let revealIx;
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Reveal attempt ${attempt}/${maxRetries}...`);
        revealIx = await randomness.revealIx();
        break;
      } catch (error) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to reveal after ${maxRetries} attempts: ${error}`);
        }
        console.log(`Failed, retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const settleIx = await myProgram.methods
      .settleSpin()
      .accounts({
        gameState: gameStatePDA,
        escrowVault: escrowVaultPDA,
        randomnessData: rngKp.publicKey,
        signer: keypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const revealTx = await sb.asV0Tx({
      connection,
      ixs: [revealIx, settleIx],
      payer: keypair.publicKey,
      signers: [keypair],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    const revealSig = await connection.sendTransaction(revealTx);
    await connection.confirmTransaction(revealSig, "confirmed");
    console.log("Revealed randomness and settled game:", revealSig);

    const tx = await connection.getParsedTransaction(revealSig, {
      maxSupportedTransactionVersion: 0,
    });

    const logs = tx?.meta?.logMessages || [];
    logs.forEach((log) => {
      if (log.includes("player won") || log.includes("player lost")) {
        console.log("  →", log);
      }
    });

    const finalGameState = await myProgram.account.gameState.fetch(gameStatePDA);
    expect(finalGameState.wager.toNumber()).to.equal(0);
    expect(finalGameState.vrfAcc.toString()).to.equal(PublicKey.default.toString());
    expect(finalGameState.commitSlot.toNumber()).to.equal(0);
    console.log("\n✅ Full randomness flow completed successfully!");
  });

  // Commit phase only test (unchanged)
  it("call spin - commit phase only", async () => {
    const { keypair, connection, program: sbProgram } = await sb.AnchorUtils.loadEnv();
    const queue = await sb.getDefaultQueue(connection.rpcEndpoint);

    const rngKp = Keypair.generate();
    const [randomness, createIx] = await sb.Randomness.create(
      sbProgram,
      rngKp,
      queue.pubkey
    );

    const createTx = await sb.asV0Tx({
      connection,
      ixs: [createIx],
      payer: keypair.publicKey,
      signers: [keypair, rngKp],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    await connection.sendTransaction(createTx);
    console.log("Randomness account created");

    const commitIx = await randomness.commitIx(queue.pubkey);

    const [gameStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_state"), keypair.publicKey.toBuffer()],
      program.programId
    );

    const [escrowVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault")],
      program.programId
    );

    const spinIx = await program.methods
      .callSpin(5, rngKp.publicKey, new anchor.BN(0.05 * LAMPORTS_PER_SOL))
      .accounts({
        gameState: gameStatePDA,
        escrowVault: escrowVaultPDA,
        randomnessData: rngKp.publicKey,
        signer: keypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const commitTx = await sb.asV0Tx({
      connection,
      ixs: [commitIx, spinIx],
      payer: keypair.publicKey,
      signers: [keypair],
      computeUnitPrice: 75_000,
      computeUnitLimitMultiple: 1.3,
    });

    const sig = await connection.sendTransaction(commitTx);
    await connection.confirmTransaction(sig, "confirmed");
    console.log("✅ Commit phase successful:", sig);
  });
});
