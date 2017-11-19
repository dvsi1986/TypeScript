/* @internal */
namespace ts.OutliningElementsCollector {
    const collapseText = "...";
    const defaultLabel = "#region";
    const regionMatch = new RegExp("^\\s*//\\s*#(end)?region(?:\\s+(.*))?$"); //why not use a literal?

    export function collectElements(sourceFile: SourceFile, cancellationToken: CancellationToken): OutliningSpan[] {
        const elements: OutliningSpan[] = [];
        addNodeOutliningSpans(sourceFile, cancellationToken, elements);
        gatherRegions(sourceFile, elements);
        return elements.sort((span1, span2) => span1.textSpan.start - span2.textSpan.start);
    }

    function addNodeOutliningSpans(sourceFile: SourceFile, cancellationToken: CancellationToken, elements: Push<OutliningSpan>): void {
        let depth = 0;
        const maxDepth = 40;
        sourceFile.forEachChild(function walk(n) {
            if (depth > maxDepth) {
                return;
            }
            cancellationToken.throwIfCancellationRequested(); //this will check on every node...

            if (isDeclaration(n)) {
                addOutliningForLeadingCommentsForNode(n, sourceFile, cancellationToken, elements);
            }

            const span = getOutliningSpanForNode(n, sourceFile);
            if (span) elements.push(span);

            depth++;
            n.forEachChild(walk);
            depth--;
        })
    }

    function gatherRegions(sourceFile: SourceFile, elements: Push<OutliningSpan>): void {
        const regions: OutliningSpan[] = [];
        const lineStarts = sourceFile.getLineStarts();
        for (let i = 0; i < lineStarts.length; i++) {
            const currentLineStart = lineStarts[i];
            const lineEnd = lineStarts[i + 1] - 1 || sourceFile.getEnd();
            const comment = sourceFile.text.substring(currentLineStart, lineEnd);
            const result = comment.match(regionMatch);

            if (!result || !isInComment(sourceFile, currentLineStart)) {
                continue;
            }

            if (!result[1]) {
                const span = createTextSpanFromBounds(sourceFile.text.indexOf("//", currentLineStart), lineEnd);
                regions.push(makeAnOutliningSpan(span, span, result[2] || defaultLabel));
            }
            else {
                const region = regions.pop();
                if (region) {
                    region.textSpan.length = lineEnd - region.textSpan.start;
                    region.hintSpan.length = lineEnd - region.textSpan.start;
                    elements.push(region);
                }
            }
        }
    }

    function addOutliningForLeadingCommentsForNode(n: Node, sourceFile: SourceFile, cancellationToken: CancellationToken, elements: Push<OutliningSpan>): void {
        const comments = ts.getLeadingCommentRangesOfNode(n, sourceFile);
        if (!comments) return;

        let firstSingleLineCommentStart = -1;
        let lastSingleLineCommentEnd = -1;
        let isFirstSingleLineComment = true;
        let singleLineCommentCount = 0;

        for (const currentComment of comments) {
            cancellationToken.throwIfCancellationRequested();

            // For single line comments, combine consecutive ones (2 or more) into
            // a single span from the start of the first till the end of the last
            if (currentComment.kind === SyntaxKind.SingleLineCommentTrivia) {
                if (isFirstSingleLineComment) {
                    firstSingleLineCommentStart = currentComment.pos;
                }
                isFirstSingleLineComment = false;
                lastSingleLineCommentEnd = currentComment.end;
                singleLineCommentCount++;
            }
            else if (currentComment.kind === SyntaxKind.MultiLineCommentTrivia) {
                combineAndAddMultipleSingleLineComments();
                elements.push(makeOutliningSpanForComment(currentComment));

                singleLineCommentCount = 0;
                lastSingleLineCommentEnd = -1;
                isFirstSingleLineComment = true;
            }
        }

        combineAndAddMultipleSingleLineComments();

        function combineAndAddMultipleSingleLineComments(): void {
            // Only outline spans of two or more consecutive single line comments
            if (singleLineCommentCount > 1) elements.push(makeOutliningSpanForComment({ kind: SyntaxKind.SingleLineCommentTrivia, pos: firstSingleLineCommentStart, end: lastSingleLineCommentEnd }));
        }
    }


    function getOutliningSpanForNode(n: Node, sourceFile: SourceFile): OutliningSpan | undefined {
        switch (n.kind) {
            case SyntaxKind.Block:
                if (!isFunctionBlock(n)) {
                    const parent = n.parent;
                    const openBrace = findChildOfKind(n, SyntaxKind.OpenBraceToken, sourceFile);
                    const closeBrace = findChildOfKind(n, SyntaxKind.CloseBraceToken, sourceFile);

                    // Check if the block is standalone, or 'attached' to some parent statement.
                    // If the latter, we want to collapse the block, but consider its hint span
                    // to be the entire span of the parent.
                    if (parent.kind === SyntaxKind.DoStatement ||
                        parent.kind === SyntaxKind.ForInStatement ||
                        parent.kind === SyntaxKind.ForOfStatement ||
                        parent.kind === SyntaxKind.ForStatement ||
                        parent.kind === SyntaxKind.IfStatement ||
                        parent.kind === SyntaxKind.WhileStatement ||
                        parent.kind === SyntaxKind.WithStatement ||
                        parent.kind === SyntaxKind.CatchClause) {

                        return makeOutliningSpan(parent, openBrace, closeBrace, autoCollapse(n), /*useFullStart*/ true, sourceFile);
                    }

                    if (parent.kind === SyntaxKind.TryStatement) {
                        // Could be the try-block, or the finally-block.
                        const tryStatement = <TryStatement>parent;
                        if (tryStatement.tryBlock === n) {
                            return makeOutliningSpan(parent, openBrace, closeBrace, autoCollapse(n), /*useFullStart*/ true, sourceFile);
                        }
                        else if (tryStatement.finallyBlock === n) {
                            const finallyKeyword = findChildOfKind(tryStatement, SyntaxKind.FinallyKeyword, sourceFile);
                            if (finallyKeyword) {
                                return makeOutliningSpan(finallyKeyword, openBrace, closeBrace, autoCollapse(n), /*useFullStart*/ true, sourceFile);
                            }
                        }

                        // fall through.
                    }

                    // Block was a standalone block.  In this case we want to only collapse
                    // the span of the block, independent of any parent span.
                    const span = createTextSpanFromNode(n);
                    return {
                        textSpan: span,
                        hintSpan: span,
                        bannerText: collapseText,
                        autoCollapse: autoCollapse(n)
                    };
                }
                // falls through

            case SyntaxKind.ModuleBlock: {
                const openBrace = findChildOfKind(n, SyntaxKind.OpenBraceToken, sourceFile)!;
                const closeBrace = findChildOfKind(n, SyntaxKind.CloseBraceToken, sourceFile)!;
                return makeOutliningSpan(n.parent, openBrace, closeBrace, autoCollapse(n), /*useFullStart*/ true, sourceFile);
            }
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.EnumDeclaration:
            case SyntaxKind.CaseBlock: {
                const openBrace = findChildOfKind(n, SyntaxKind.OpenBraceToken, sourceFile);
                const closeBrace = findChildOfKind(n, SyntaxKind.CloseBraceToken, sourceFile);
                return makeOutliningSpan(n, openBrace, closeBrace, autoCollapse(n), /*useFullStart*/ true, sourceFile);
            }
            // If the block has no leading keywords and is inside an array literal,
            // we only want to collapse the span of the block.
            // Otherwise, the collapsed section will include the end of the previous line.
            case SyntaxKind.ObjectLiteralExpression:
                const openBrace = findChildOfKind(n, SyntaxKind.OpenBraceToken, sourceFile);
                const closeBrace = findChildOfKind(n, SyntaxKind.CloseBraceToken, sourceFile);
                return makeOutliningSpan(n, openBrace, closeBrace, autoCollapse(n), /*useFullStart*/ !isArrayLiteralExpression(n.parent), sourceFile);
            case SyntaxKind.ArrayLiteralExpression:
                const openBracket = findChildOfKind(n, SyntaxKind.OpenBracketToken, sourceFile);
                const closeBracket = findChildOfKind(n, SyntaxKind.CloseBracketToken, sourceFile);
                return makeOutliningSpan(n, openBracket, closeBracket, autoCollapse(n), /*useFullStart*/ !isArrayLiteralExpression(n.parent), sourceFile);
        }
    }

    //name
    function makeOutliningSpanForComment(commentSpan: CommentRange): OutliningSpan {
        const span = createTextSpanFromBounds(commentSpan.pos, commentSpan.end);
        return makeAnOutliningSpan(span, span, collapseText);
    }

    //!
    function makeAnOutliningSpan(textSpan: TextSpan, hintSpan: TextSpan, bannerText: string, autoCollapse = false) {
        return { textSpan, hintSpan, bannerText, autoCollapse }
    }

    /** If useFullStart is true, then the collapsing span includes leading whitespace, including linebreaks. */
    function makeOutliningSpan(hintSpanNode: Node, startElement: Node, endElement: Node, autoCollapse: boolean, useFullStart: boolean, sourceFile: SourceFile): OutliningSpan | undefined {
        //assert these tings defined
        return hintSpanNode && startElement && endElement && {
            textSpan: createTextSpanFromBounds(useFullStart ? startElement.getFullStart() : startElement.getStart(), endElement.getEnd()),
            hintSpan: createTextSpanFromNode(hintSpanNode, sourceFile),
            bannerText: collapseText,
            autoCollapse,
        };
    }

    function autoCollapse(node: Node): boolean {
        return isFunctionBlock(node) && node.parent.kind !== SyntaxKind.ArrowFunction;
    }
}