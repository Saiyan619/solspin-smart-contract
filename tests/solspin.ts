import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solspin } from "../target/types/solspin";
import { expect } from "chai";
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
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  
  let queue: sb.Queue;
  let escrowVault: PublicKey;
  let escrowVaultBump: number;

  before(async () => {
    console.log("Setting up test environment...");
    console.log("RPC Endpoint:", connection.rpcEndpoint);
    
    // Get the default Switchboard queue - pass RPC endpoint directly as shown in docs
    try {
      // The docs show: queue = await sb.getDefaultQueue(connection.rpcEndpoint);
      // But we need to ensure it's the full URL
      const rpcEndpoint = "https://api.devnet.solana.com";
      queue = await sb.getDefaultQueue(rpcEndpoint);
      console.log("Switchboard Queue:", queue.pubkey.toString());
    } catch (err) {
      console.error("Failed to get Switchboard queue:", err);
      throw err;
    }

    // Derive escrow vault PDA
    [escrowVault, escrowVaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault")],
      program.programId
    );

    console.log("Program ID:", program.programId.toString());
    console.log("Escrow Vault:", escrowVault.toString());
  });

  describe("initialize_house", () => {
    it("successfully initializes house vault", async () => {
      try {
        const tx = await program.methods
          .initializeHouse()
          .accounts({
            admin: payer.publicKey,
            escrowVault: escrowVault,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        console.log("Initialize house tx:", tx);

        // Verify vault exists
        const vaultAccount = await connection.getAccountInfo(escrowVault);
        expect(vaultAccount).to.not.be.null;
        console.log("Vault created with balance:", vaultAccount.lamports);

        // Fund the vault for testing
        const fundTx = await connection.requestAirdrop(
          escrowVault,
          10 * LAMPORTS_PER_SOL
        );
        await connection.confirmTransaction(fundTx);
        console.log("Vault funded with 10 SOL");
      } catch (err) {
        if (err.toString().includes("already in use")) {
          console.log("House already initialized");
        } else {
          throw err;
        }
      }
    });
  });

  describe("Player lifecycle", () => {
    let player: Keypair;
    let gameState: PublicKey;
    let randomnessAccount: Keypair;
    let randomness: sb.Randomness;

    beforeEach(async () => {
      // Create new player
      player = Keypair.generate();
      
      // Airdrop to player
      const airdropSig = await connection.requestAirdrop(
        player.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig);
      console.log("Player funded:", player.publicKey.toString());

      // Derive game state PDA
      [gameState] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_state"), player.publicKey.toBuffer()],
        program.programId
      );

      // Initialize player's game state
      await program.methods
        .initialize()
        .accounts({
          gameState: gameState,
          signer: player.publicKey,
          escrowVault: escrowVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      console.log("Player game state initialized:", gameState.toString());
    });

    it("completes full game cycle - player wins or loses", async () => {
      // Generate keypair for randomness account
      randomnessAccount = Keypair.generate();
      console.log("Randomness account:", randomnessAccount.publicKey.toString());

      // Create the randomness account (CORRECT: only 2 params)
      const [randomness, createIx] = await sb.Randomness.create(
        randomnessAccount,
        queue
      );

      // Send creation transaction
      const createTx = await sb.asV0Tx({
        connection,
        ixs: [createIx],
        payer: payer.publicKey,
        signers: [payer, randomnessAccount],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      const createSig = await connection.sendTransaction(createTx);
      await connection.confirmTransaction(createSig, "confirmed");
      console.log("Randomness account created:", createSig);

      // Player's guess and wager
      const playerGuess = 3; // Guess color 3
      const wager = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

      // Get balances before
      const playerBalanceBefore = await connection.getBalance(player.publicKey);
      const vaultBalanceBefore = await connection.getBalance(escrowVault);

      console.log("\n=== COMMIT PHASE ===");
      
      // Create commit instruction with retry
      const commitIx = await retryCommit(randomness, queue);

      // Create call_spin instruction
      const callSpinIx = await program.methods
        .callSpin(playerGuess, randomnessAccount.publicKey, wager)
        .accounts({
          gameState: gameState,
          escrowVault: escrowVault,
          randomnessData: randomnessAccount.publicKey,
          signer: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      // Bundle commit + call_spin in same transaction
      const commitTx = await sb.asV0Tx({
        connection,
        ixs: [commitIx, callSpinIx],
        payer: player.publicKey,
        signers: [player],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      const commitSig = await connection.sendTransaction(commitTx);
      await connection.confirmTransaction(commitSig, "confirmed");
      console.log("Committed! Transaction:", commitSig);

      // Verify game state after commit
      const gameStateAfterCommit = await program.account.gameState.fetch(gameState);
      console.log("Game state after commit:");
      console.log("  Player guess:", gameStateAfterCommit.playerGuess);
      console.log("  Wager:", gameStateAfterCommit.wager.toString());
      console.log("  Commit slot:", gameStateAfterCommit.commitSlot.toString());

      expect(gameStateAfterCommit.playerGuess).to.equal(playerGuess);
      expect(gameStateAfterCommit.wager.toNumber()).to.equal(wager.toNumber());
      expect(gameStateAfterCommit.commitSlot.toNumber()).to.be.greaterThan(0);

      // Verify wager transferred to vault
      const vaultBalanceAfterCommit = await connection.getBalance(escrowVault);
      expect(vaultBalanceAfterCommit).to.be.greaterThan(vaultBalanceBefore);
      console.log("Wager transferred to vault successfully");

      // Wait for randomness to be generated
      console.log("\n=== WAITING FOR RANDOMNESS ===");
      console.log("Waiting for randomness generation...");
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log("\n=== REVEAL PHASE ===");
      
      // Create reveal instruction with retry
      const revealIx = await retryReveal(randomness);

      // Create settle_spin instruction
      const settleSpinIx = await program.methods
        .settleSpin()
        .accounts({
          gameState: gameState,
          escrowVault: escrowVault,
          randomnessData: randomnessAccount.publicKey,
          signer: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      // Bundle reveal + settle_spin in same transaction
      const revealTx = await sb.asV0Tx({
        connection,
        ixs: [revealIx, settleSpinIx],
        payer: player.publicKey,
        signers: [player],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      const revealSig = await connection.sendTransaction(revealTx);
      await connection.confirmTransaction(revealSig, "confirmed");
      console.log("Revealed! Transaction:", revealSig);

      // Parse result from logs
      const tx = await connection.getParsedTransaction(revealSig, {
        maxSupportedTransactionVersion: 0,
      });

      console.log("\n=== RESULTS ===");
      
      // Find win/loss log
      const resultLog = tx?.meta?.logMessages?.find(line =>
        line.includes("player won!!") || line.includes("player lost")
      );
      console.log("Game result:", resultLog);

      // Get final balances
      const playerBalanceAfter = await connection.getBalance(player.publicKey);
      const vaultBalanceAfter = await connection.getBalance(escrowVault);

      console.log("\nBalance changes:");
      console.log("  Player before:", playerBalanceBefore / LAMPORTS_PER_SOL, "SOL");
      console.log("  Player after:", playerBalanceAfter / LAMPORTS_PER_SOL, "SOL");
      console.log("  Vault before:", vaultBalanceBefore / LAMPORTS_PER_SOL, "SOL");
      console.log("  Vault after:", vaultBalanceAfter / LAMPORTS_PER_SOL, "SOL");

      // Verify game state was reset
      const gameStateAfterSettle = await program.account.gameState.fetch(gameState);
      expect(gameStateAfterSettle.commitSlot.toNumber()).to.equal(0);
      expect(gameStateAfterSettle.wager.toNumber()).to.equal(0);
      expect(gameStateAfterSettle.vrfAcc.toString()).to.equal(PublicKey.default.toString());
      console.log("Game state successfully reset");
    });

    it("rejects zero bet", async () => {
      randomnessAccount = Keypair.generate();
      
      const [randomness, createIx] = await sb.Randomness.create(
        randomnessAccount,
        queue
      );

      const createTx = await sb.asV0Tx({
        connection,
        ixs: [createIx],
        payer: payer.publicKey,
        signers: [payer, randomnessAccount],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      await connection.sendTransaction(createTx);

      const commitIx = await retryCommit(randomness, queue);
      const zeroBet = new anchor.BN(0);

      const callSpinIx = await program.methods
        .callSpin(3, randomnessAccount.publicKey, zeroBet)
        .accounts({
          gameState: gameState,
          escrowVault: escrowVault,
          randomnessData: randomnessAccount.publicKey,
          signer: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const tx = await sb.asV0Tx({
        connection,
        ixs: [commitIx, callSpinIx],
        payer: player.publicKey,
        signers: [player],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      try {
        await connection.sendTransaction(tx);
        expect.fail("Should have rejected zero bet");
      } catch (err) {
        expect(err.toString()).to.include("ZeroBet");
        console.log("✓ Zero bet rejected successfully");
      }
    });

    it("rejects invalid guess (>= 6)", async () => {
      randomnessAccount = Keypair.generate();
      
      const [randomness, createIx] = await sb.Randomness.create(
        randomnessAccount,
        queue
      );

      const createTx = await sb.asV0Tx({
        connection,
        ixs: [createIx],
        payer: payer.publicKey,
        signers: [payer, randomnessAccount],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      await connection.sendTransaction(createTx);

      const commitIx = await retryCommit(randomness, queue);
      const invalidGuess = 6;
      const wager = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

      const callSpinIx = await program.methods
        .callSpin(invalidGuess, randomnessAccount.publicKey, wager)
        .accounts({
          gameState: gameState,
          escrowVault: escrowVault,
          randomnessData: randomnessAccount.publicKey,
          signer: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const tx = await sb.asV0Tx({
        connection,
        ixs: [commitIx, callSpinIx],
        payer: player.publicKey,
        signers: [player],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      try {
        await connection.sendTransaction(tx);
        expect.fail("Should have rejected invalid guess");
      } catch (err) {
        expect(err.toString()).to.include("InvalidGuess");
        console.log("✓ Invalid guess rejected successfully");
      }
    });

    it("accepts all valid guesses (0-5)", async () => {
      for (let guess = 0; guess < 6; guess++) {
        const testPlayer = Keypair.generate();
        
        const airdropSig = await connection.requestAirdrop(
          testPlayer.publicKey,
          2 * LAMPORTS_PER_SOL
        );
        await connection.confirmTransaction(airdropSig);

        const [testGameState] = PublicKey.findProgramAddressSync(
          [Buffer.from("game_state"), testPlayer.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initialize()
          .accounts({
            gameState: testGameState,
            signer: testPlayer.publicKey,
            escrowVault: escrowVault,
            systemProgram: SystemProgram.programId,
          })
          .signers([testPlayer])
          .rpc();

        const rngKp = Keypair.generate();
        const [rng, createIx] = await sb.Randomness.create(
          rngKp,
          queue
        );

        const createTx = await sb.asV0Tx({
          connection,
          ixs: [createIx],
          payer: payer.publicKey,
          signers: [payer, rngKp],
          computeUnitPrice: 75_000,
          computeUnitLimitMultiple: 1.3,
        });

        await connection.sendTransaction(createTx);

        const commitIx = await retryCommit(rng, queue);
        const wager = new anchor.BN(0.01 * LAMPORTS_PER_SOL);

        const callSpinIx = await program.methods
          .callSpin(guess, rngKp.publicKey, wager)
          .accounts({
            gameState: testGameState,
            escrowVault: escrowVault,
            randomnessData: rngKp.publicKey,
            signer: testPlayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        const tx = await sb.asV0Tx({
          connection,
          ixs: [commitIx, callSpinIx],
          payer: testPlayer.publicKey,
          signers: [testPlayer],
          computeUnitPrice: 75_000,
          computeUnitLimitMultiple: 1.3,
        });

        await connection.sendTransaction(tx);
        console.log(`✓ Guess ${guess} accepted`);
      }
    });
  });

  describe("Security tests", () => {
    let player: Keypair;
    let gameState: PublicKey;

    beforeEach(async () => {
      player = Keypair.generate();
      
      const airdropSig = await connection.requestAirdrop(
        player.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig);

      [gameState] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_state"), player.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .initialize()
        .accounts({
          gameState: gameState,
          signer: player.publicKey,
          escrowVault: escrowVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();
    });

    it("rejects settlement with wrong randomness account", async () => {
      // Create first randomness account and commit
      const rngKp1 = Keypair.generate();
      const [rng1, createIx1] = await sb.Randomness.create(
        rngKp1,
        queue
      );

      const createTx1 = await sb.asV0Tx({
        connection,
        ixs: [createIx1],
        payer: payer.publicKey,
        signers: [payer, rngKp1],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      await connection.sendTransaction(createTx1);

      const commitIx = await retryCommit(rng1, queue);
      const wager = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

      const callSpinIx = await program.methods
        .callSpin(3, rngKp1.publicKey, wager)
        .accounts({
          gameState: gameState,
          escrowVault: escrowVault,
          randomnessData: rngKp1.publicKey,
          signer: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const commitTx = await sb.asV0Tx({
        connection,
        ixs: [commitIx, callSpinIx],
        payer: player.publicKey,
        signers: [player],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      await connection.sendTransaction(commitTx);
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Create second randomness account (wrong one)
      const rngKp2 = Keypair.generate();
      const [rng2, createIx2] = await sb.Randomness.create(
        rngKp2,
        queue
      );

      const createTx2 = await sb.asV0Tx({
        connection,
        ixs: [createIx2],
        payer: payer.publicKey,
        signers: [payer, rngKp2],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      await connection.sendTransaction(createTx2);

      // Try to settle with wrong randomness account
      const revealIx = await retryReveal(rng2);
      const settleSpinIx = await program.methods
        .settleSpin()
        .accounts({
          gameState: gameState,
          escrowVault: escrowVault,
          randomnessData: rngKp2.publicKey, // Wrong account!
          signer: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const revealTx = await sb.asV0Tx({
        connection,
        ixs: [revealIx, settleSpinIx],
        payer: player.publicKey,
        signers: [player],
        computeUnitPrice: 75_000,
        computeUnitLimitMultiple: 1.3,
      });

      try {
        await connection.sendTransaction(revealTx);
        expect.fail("Should have rejected wrong randomness account");
      } catch (err) {
        expect(err.toString()).to.include("WrongRandomDataAcc");
        console.log("✓ Wrong randomness account rejected");
      }
    });
  });

  describe("Multiple players", () => {
    it("allows multiple players to play simultaneously", async () => {
      const player1 = Keypair.generate();
      const player2 = Keypair.generate();

      // Fund players
      await connection.requestAirdrop(player1.publicKey, 3 * LAMPORTS_PER_SOL);
      await connection.requestAirdrop(player2.publicKey, 3 * LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Derive game states
      const [gameState1] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_state"), player1.publicKey.toBuffer()],
        program.programId
      );

      const [gameState2] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_state"), player2.publicKey.toBuffer()],
        program.programId
      );

      // Initialize both
      await program.methods
        .initialize()
        .accounts({
          gameState: gameState1,
          signer: player1.publicKey,
          escrowVault: escrowVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([player1])
        .rpc();

      await program.methods
        .initialize()
        .accounts({
          gameState: gameState2,
          signer: player2.publicKey,
          escrowVault: escrowVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([player2])
        .rpc();

      // Verify independent states
      const state1 = await program.account.gameState.fetch(gameState1);
      const state2 = await program.account.gameState.fetch(gameState2);

      expect(state1.wager.toNumber()).to.equal(0);
      expect(state2.wager.toNumber()).to.equal(0);
      console.log("✓ Multiple players can initialize independently");
    });
  });
});

// Helper functions with retry logic
async function retryCommit(
  randomness: sb.Randomness,
  queue: sb.Queue,
  maxRetries = 3
): Promise<anchor.web3.TransactionInstruction> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Commit attempt ${attempt}/${maxRetries}...`);
      return await randomness.commitIx(queue);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Failed, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error("All commit attempts failed");
}

async function retryReveal(
  randomness: sb.Randomness,
  maxRetries = 5
): Promise<anchor.web3.TransactionInstruction> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Reveal attempt ${attempt}/${maxRetries}...`);
      return await randomness.revealIx();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Failed, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error("All reveal attempts failed");
}